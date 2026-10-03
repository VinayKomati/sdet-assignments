'use strict';
const express=require('express');const crypto=require('node:crypto');const {DomainError}=require('./domain');
function createBillingApp(service,{webhookSecret='test_webhook_secret'}={}){
  const app=express();
  app.post('/webhooks/payment-provider',express.raw({type:'application/json'}),async(req,res,next)=>{
    try{
      if(!Buffer.isBuffer(req.body))throw new DomainError('Content-Type must be application/json');
      const supplied=req.get('X-Provider-Signature')||'';const expected=crypto.createHmac('sha256',webhookSecret).update(req.body).digest('hex');
      const a=Buffer.from(supplied);const b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw new DomainError('Invalid provider signature',401);
      let event;try{event=JSON.parse(req.body.toString('utf8'));}catch{throw new DomainError('Malformed JSON payload');}
      res.json(await service.receiveEvent(event));
    }catch(e){next(e);}
  });
  app.use(express.json());
  app.post('/subscriptions',async(req,res,next)=>{try{res.status(201).json(await service.createSubscription(req.body));}catch(e){next(e);}});
  app.get('/subscriptions/:id',async(req,res,next)=>{try{res.json(await service.getSubscription(req.params.id));}catch(e){next(e);}});
  app.post('/subscriptions/:id/cancel',async(req,res,next)=>{try{res.json(await service.cancelSubscription(req.params.id));}catch(e){next(e);}});
  app.post('/subscriptions/:id/retries-exhausted',async(req,res,next)=>{try{res.json(await service.exhaustRetries(req.params.id));}catch(e){next(e);}});
  app.patch('/subscriptions/:id/plan',async(req,res,next)=>{try{res.json(await service.changePlan(req.params.id,req.body.plan));}catch(e){next(e);}});
  app.get('/subscriptions/:id/invoices',async(req,res,next)=>{try{const data=await service.repository.snapshot();if(!data.subscriptions.some(x=>x.id===req.params.id))throw new DomainError('Subscription not found',404);res.json(data.invoices.filter(x=>x.subscription_id===req.params.id));}catch(e){next(e);}});
  app.use((error,req,res,_next)=>res.status(error.status||500).json({error:error.message}));return app;
}
module.exports={createBillingApp};
