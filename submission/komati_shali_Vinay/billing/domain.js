'use strict';
const { randomUUID } = require('node:crypto');

class DomainError extends Error { constructor(message,status=400){super(message);this.status=status;} }
class PlanCatalog {
  constructor(plans={basic:{amount:1900,trialDays:0},pro:{amount:4900,trialDays:14}}){this.plans=Object.freeze(plans);}
  get(name){const plan=this.plans[name];if(!plan)throw new DomainError('Unknown plan');return plan;}
}

class SubscriptionStateMachine {
  static transitions={trialing:{active:'payment.succeeded',past_due:'payment.failed',canceled:'api.cancel'},active:{past_due:'payment.failed',canceled:'api.cancel'},past_due:{active:'payment.succeeded',canceled:'retries.exhausted'},canceled:{}};
  transition(subscription,next,trigger){const allowed=SubscriptionStateMachine.transitions[subscription.status]||{};if(allowed[next]!==trigger)throw new DomainError(`Invalid transition ${subscription.status} -> ${next}`,409);subscription.status=next;return subscription;}
}

class BillingService {
  constructor(repository,paymentProvider,options={}){this.repository=repository;this.paymentProvider=paymentProvider;this.plans=options.plans||new PlanCatalog();this.machine=new SubscriptionStateMachine();}
  async createSubscription({customer_id,plan,payment_method_id}){
    if(!customer_id||!/^cust_[a-zA-Z0-9_-]+$/.test(customer_id)||!payment_method_id||!/^pm_[a-zA-Z0-9_-]+$/.test(payment_method_id))throw new DomainError('Valid customer_id and payment_method_id are required');
    if(!(await this.repository.hasCustomer(customer_id)))throw new DomainError('Unknown customer');
    const config=this.plans.get(plan);const id=`sub_${randomUUID()}`;const now=new Date().toISOString();
    const sub={id,customer_id,plan,payment_method_id,status:config.trialDays?'trialing':'active',trial_days:config.trialDays,created_at:now,cancel_at_period_end:false};
    await this.repository.saveSubscription(sub);
    if(config.trialDays){await this.createInvoice(sub,config.amount,'trial_ending');}
    else{
      const invoice=await this.createInvoice(sub,config.amount,'initial');
      let outcome;
      try{outcome=await this.paymentProvider.charge({customerId:customer_id,paymentMethodId:payment_method_id,amount:config.amount,currency:'USD',invoiceId:invoice.id,idempotencyKey:`${id}:initial`});}
      catch(error){outcome={status:error.code==='ETIMEDOUT'?'timeout':'declined',reference:null};}
      await this.applyChargeOutcome(sub,invoice,outcome,'initial_charge');
    }
    await this.repository.saveSubscription(sub);await this.audit(sub.id,'subscription.created',{status:sub.status,plan});return sub;
  }
  async getSubscription(id){const s=await this.repository.getSubscription(id);if(!s)throw new DomainError('Subscription not found',404);return s;}
  async cancelSubscription(id){const s=await this.getSubscription(id);this.machine.transition(s,'canceled','api.cancel');s.cancel_at_period_end=false;s.canceled_at=new Date().toISOString();await this.repository.saveSubscription(s);await this.audit(id,'subscription.canceled',{});return s;}
  async exhaustRetries(id){const s=await this.getSubscription(id);this.machine.transition(s,'canceled','retries.exhausted');s.canceled_at=new Date().toISOString();await this.repository.saveSubscription(s);await this.audit(id,'subscription.retries_exhausted',{});return s;}
  async changePlan(id,plan){const config=this.plans.get(plan);const s=await this.getSubscription(id);if(!['trialing','active'].includes(s.status))throw new DomainError('Plan cannot be changed in this state',409);const wasTrialing=s.status==='trialing';s.plan=plan;s.trial_days=wasTrialing?config.trialDays:0;await this.repository.saveSubscription(s);await this.audit(id,'subscription.plan_changed',{plan});if(wasTrialing&&!config.trialDays){const invoice=await this.createInvoice(s,config.amount,'plan_change');let outcome;try{outcome=await this.paymentProvider.charge({customerId:s.customer_id,paymentMethodId:s.payment_method_id,amount:config.amount,currency:'USD',invoiceId:invoice.id,idempotencyKey:`${id}:plan:${plan}:${invoice.id}`});}catch(error){outcome={status:error.code==='ETIMEDOUT'?'timeout':'declined',reference:null};}await this.applyChargeOutcome(s,invoice,outcome,'plan_change');}return s;}
  async createInvoice(subscription,amount,reason){const invoice={id:`inv_${randomUUID()}`,subscription_id:subscription.id,amount,currency:'USD',status:'open',reason,created_at:new Date().toISOString()};await this.repository.saveInvoice(invoice);return invoice;}
  async applyChargeOutcome(subscription,invoice,outcome,reason){
    const success=outcome&&outcome.status==='succeeded';invoice.status=success?'paid':'failed';
    const payment={id:`pay_${randomUUID()}`,invoice_id:invoice.id,subscription_id:subscription.id,status:success?'succeeded':'failed',amount:invoice.amount,currency:invoice.currency,provider_reference:outcome&&outcome.reference||null,reason,created_at:new Date().toISOString()};
    await this.repository.saveInvoice(invoice);await this.repository.savePayment(payment);
    if(success){if(subscription.status==='trialing'||subscription.status==='past_due')this.machine.transition(subscription,'active','payment.succeeded');}
    else if(subscription.status==='active'||subscription.status==='trialing')this.machine.transition(subscription,'past_due','payment.failed');
    await this.repository.saveSubscription(subscription);await this.audit(subscription.id,`payment.${payment.status}`,{invoice_id:invoice.id,payment_id:payment.id});
  }
  async receiveEvent(event){
    if(!event||!event.event_id||!event.type||!event.invoice_id||!event.subscription_id||!Number.isSafeInteger(event.amount)||event.amount<=0||!event.currency||!event.created_at||!Number.isFinite(Date.parse(event.created_at)))throw new DomainError('Malformed payment webhook');
    return this.repository.withLock(async()=>{
      const existing=await this.repository.getEvent(event.event_id);
      if(existing){await this.repository.saveDelivery({...event,duplicate:true,processed:false,received_at:new Date().toISOString()});await this.audit(existing.subscription_id,'webhook.duplicate',{event_id:event.event_id});return {duplicate:true};}
      const sub=await this.getSubscription(event.subscription_id);const invoice=await this.repository.getInvoice(event.invoice_id);
      if(!invoice||invoice.subscription_id!==sub.id||invoice.amount!==event.amount||invoice.currency!==event.currency)throw new DomainError('Webhook does not match invoice',422);
      const newest=await this.repository.latestEventForInvoice(invoice.id);const stale=newest&&Date.parse(event.created_at)<Date.parse(newest.created_at);
      let applied=false;
      if(!stale&&sub.status!=='canceled'){
        if(event.type==='payment.succeeded'&&invoice.status!=='refunded'&&(sub.status==='trialing'||sub.status==='past_due')){this.machine.transition(sub,'active','payment.succeeded');invoice.status='paid';await this.repository.saveInvoice(invoice);await this.repository.savePayment({id:`pay_${randomUUID()}`,invoice_id:invoice.id,subscription_id:sub.id,status:'succeeded',amount:invoice.amount,currency:invoice.currency,provider_reference:event.provider_reference||null,reason:'webhook',created_at:new Date().toISOString()});applied=true;}
        else if(event.type==='payment.failed'&&!['paid','refunded'].includes(invoice.status)&&(sub.status==='active'||sub.status==='trialing')){this.machine.transition(sub,'past_due','payment.failed');invoice.status='failed';await this.repository.saveInvoice(invoice);await this.repository.savePayment({id:`pay_${randomUUID()}`,invoice_id:invoice.id,subscription_id:sub.id,status:'failed',amount:invoice.amount,currency:invoice.currency,provider_reference:event.provider_reference||null,reason:'webhook',created_at:new Date().toISOString()});applied=true;}
        else if(event.type==='payment.refunded'&&invoice.status==='paid'){invoice.status='refunded';await this.repository.saveInvoice(invoice);await this.repository.savePayment({id:`pay_${randomUUID()}`,invoice_id:invoice.id,subscription_id:sub.id,status:'refunded',amount:invoice.amount,currency:invoice.currency,provider_reference:event.provider_reference||null,reason:'webhook',created_at:new Date().toISOString()});applied=true;}
        else if(!['payment.succeeded','payment.failed','payment.refunded'].includes(event.type))throw new DomainError('Unsupported webhook event type');
      }
      await this.repository.saveSubscription(sub);await this.repository.saveEvent({...event,duplicate:false,processed:applied,stale:Boolean(stale),received_at:new Date().toISOString()});
      if(applied)await this.audit(sub.id,event.type,{invoice_id:invoice.id,event_id:event.event_id});return {duplicate:false,stale:Boolean(stale),applied,subscription:sub,invoice};
    });
  }
  async audit(subscription_id,type,details){await this.repository.saveAudit({id:`aud_${randomUUID()}`,subscription_id,type,details,created_at:new Date().toISOString()});}
}
module.exports={BillingService,DomainError,PlanCatalog,SubscriptionStateMachine};
