import { test, expect } from './fixture';
import { SubscriptionBuilder } from './page';
import { expectApiAndRepositoryAgree, paymentEvent, records } from './helpers';
import type { PaymentWebhook } from './page';

test('basic plan charges the configured amount and persists payment, invoice, and audit', async ({ fixture, billingPage: page }) => {
  const created = await page.createSubscription(new SubscriptionBuilder().customer('cust_001').build());
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ status: 'active', plan: 'basic', trial_days: 0 });
  const invoice = (await page.getInvoices(created.body.id)).body[0];
  expect(invoice).toMatchObject({ amount: 1900, currency: 'USD', status: 'paid' });
  expect(fixture.provider.calls).toEqual([{
    customerId: 'cust_001', paymentMethodId: 'pm_test_visa_4242', amount: 1900,
    currency: 'USD', invoiceId: invoice.id, idempotencyKey: `${created.body.id}:initial`,
  }]);
  const saved = await records(fixture, created.body.id);
  expect(saved.payments.map((payment: any) => payment.status)).toEqual(['succeeded']);
  expect(saved.audit.length).toBeGreaterThanOrEqual(2);
  await expectApiAndRepositoryAgree(fixture, page, created.body.id);
});

test('pro trial transitions through failure to success without an initial provider charge', async ({ fixture, billingPage: page }) => {
  const created = await page.createSubscription(new SubscriptionBuilder().customer('cust_trial').plan('pro').build());
  expect(created.body).toMatchObject({ status: 'trialing', trial_days: 14 });
  expect(fixture.provider.calls).toHaveLength(0);
  const invoice = (await page.getInvoices(created.body.id)).body[0];
  expect(invoice).toMatchObject({ amount: 4900, status: 'open' });

  const failed = await page.sendSignedWebhook(paymentEvent(page, created.body.id, invoice, 'payment.failed', 'evt_trial_fail', '2026-01-01T00:00:00Z'));
  expect(failed.status).toBe(200);
  expect((await page.getSubscription(created.body.id)).body.status).toBe('past_due');
  await expectApiAndRepositoryAgree(fixture, page, created.body.id);

  await page.sendSignedWebhook(paymentEvent(page, created.body.id, invoice, 'payment.succeeded', 'evt_trial_success', '2026-01-02T00:00:00Z'));
  expect((await page.getSubscription(created.body.id)).body.status).toBe('active');
  expect((await records(fixture, created.body.id)).payments.map((payment: any) => payment.status)).toEqual(['failed', 'succeeded']);
  await expectApiAndRepositoryAgree(fixture, page, created.body.id);
});

test('decline moves to past_due, retry success recovers, and exhausted retries cancel', async ({ fixture, billingPage: page }) => {
  fixture.provider.enqueue({ status: 'declined', reference: 'decline_1' });
  const created = await page.createSubscription(new SubscriptionBuilder().customer('cust_retry').build());
  expect(created.body.status).toBe('past_due');
  expect(fixture.provider.calls).toHaveLength(1);
  const state = await records(fixture, created.body.id);
  expect(state.payments[0]).toMatchObject({ status: 'failed', provider_reference: 'decline_1' });
  const invoice = state.invoices[0];

  await page.sendSignedWebhook(paymentEvent(page, created.body.id, invoice, 'payment.succeeded', 'evt_retry_ok', '2026-02-02T00:00:00Z'));
  expect((await page.getSubscription(created.body.id)).body.status).toBe('active');
  expect((await page.exhaustRetries(created.body.id)).status).toBe(409);
  await page.cancelSubscription(created.body.id);
  expect((await page.getSubscription(created.body.id)).body.status).toBe('canceled');
  await expectApiAndRepositoryAgree(fixture, page, created.body.id);
});

test('provider timeout is recorded as a failed attempt', async ({ fixture, billingPage: page }) => {
  fixture.provider.enqueue({ status: 'timeout' });
  const created = await page.createSubscription(new SubscriptionBuilder().customer('cust_timeout').build());
  expect(created.body.status).toBe('past_due');
  const saved = await records(fixture, created.body.id);
  expect(saved.invoices[0].status).toBe('failed');
  expect(saved.payments[0]).toMatchObject({ status: 'failed', provider_reference: null });
  expect(fixture.provider.calls).toHaveLength(1);
});

test('validation errors have no provider or persistence side effects', async ({ fixture, billingPage: page }) => {
  for (const body of [
    { customer_id: 'cust_default', plan: 'unknown', payment_method_id: 'pm_test' },
    { customer_id: '', plan: 'basic', payment_method_id: 'pm_test' },
    { customer_id: 'cust_default', plan: 'basic', payment_method_id: '' },
    { customer_id: 'cust_unknown', plan: 'basic', payment_method_id: 'pm_test' },
  ]) expect((await page.createSubscription(body)).status).toBe(400);
  expect((await page.createWithoutBody()).status).toBe(400);
  expect(fixture.provider.calls).toHaveLength(0);
  expect((await fixture.repository.snapshot()).subscriptions).toHaveLength(0);
});

test('unknown subscription resources and webhook invoice references are rejected without mutations', async ({ fixture, billingPage: page }) => {
  expect((await page.getSubscription('sub_does_not_exist')).status).toBe(404);
  expect((await page.cancelSubscription('sub_does_not_exist')).status).toBe(404);
  expect((await page.changePlan('sub_does_not_exist', 'basic')).status).toBe(404);
  expect((await page.getInvoices('sub_does_not_exist')).status).toBe(404);
  expect(fixture.provider.calls).toHaveLength(0);
  const state = await fixture.repository.snapshot();
  expect(state.subscriptions).toHaveLength(0);
  expect(state.invoices).toHaveLength(0);
});

test('rejects missing, tampered, malformed, unsupported, and mismatched webhooks without side effects', async ({ fixture, billingPage: page }) => {
  const trial = await page.createSubscription(new SubscriptionBuilder().plan('pro').build());
  const invoice = (await page.getInvoices(trial.body.id)).body[0];
  const valid = paymentEvent(page, trial.body.id, invoice, 'payment.succeeded', 'evt_negative', '2026-07-01T00:00:00Z');

  expect((await page.sendWebhookWithoutSignature(valid)).status).toBe(401);
  expect((await page.sendTamperedWebhook(valid)).status).toBe(401);
  expect((await page.sendMalformedWebhook()).status).toBe(400);
  expect((await page.sendSignedPayload({ event_id: 'evt_missing_fields', type: 'payment.succeeded' })).status).toBe(400);
  expect((await page.sendSignedWebhook({ ...valid, amount: -1 })).status).toBe(400);
  expect((await page.sendSignedWebhook({ ...valid, created_at: 'not-a-date' })).status).toBe(400);
  expect((await page.sendSignedWebhook({ ...valid, type: 'payment.chargeback' })).status).toBe(400);
  expect((await page.sendSignedWebhook({ ...valid, subscription_id: 'sub_missing' })).status).toBe(404);
  expect((await page.sendSignedWebhook({ ...valid, invoice_id: 'inv_missing' })).status).toBe(422);
  expect((await page.sendSignedWebhook({ ...valid, amount: invoice.amount + 1 })).status).toBe(422);
  expect((await page.sendSignedWebhook({ ...valid, currency: 'EUR' })).status).toBe(422);

  const saved = await records(fixture, trial.body.id);
  expect(saved.events).toHaveLength(0);
  expect(saved.payments).toHaveLength(0);
  expect(saved.invoices[0].status).toBe('open');
  expect((await page.getSubscription(trial.body.id)).body.status).toBe('trialing');
  expect(fixture.provider.calls).toHaveLength(0);
});

test('API cancellation works for active and trialing subscriptions and cannot repeat', async ({ fixture, billingPage: page }) => {
  const active = await page.createSubscription(new SubscriptionBuilder().build());
  expect((await page.cancelSubscription(active.body.id)).body.status).toBe('canceled');
  expect((await page.cancelSubscription(active.body.id)).status).toBe(409);
  const trial = await page.createSubscription(new SubscriptionBuilder().customer('cust_trial_cancel').plan('pro').build());
  expect(trial.body.status).toBe('trialing');
  expect((await page.cancelSubscription(trial.body.id)).body.status).toBe('canceled');
  expect(fixture.provider.calls).toHaveLength(1);
  await expectApiAndRepositoryAgree(fixture, page, trial.body.id);
});

test('plan changes apply the new plan price when a trial switches to immediate billing', async ({ fixture, billingPage: page }) => {
  const trial = await page.createSubscription(new SubscriptionBuilder().plan('pro').build());
  expect((await page.changePlan(trial.body.id, 'basic')).status).toBe(200);
  const current = await page.getSubscription(trial.body.id);
  expect(current.body).toMatchObject({ status: 'active', plan: 'basic', trial_days: 0 });
  const invoices = (await page.getInvoices(trial.body.id)).body;
  expect(invoices.map((invoice: any) => invoice.amount)).toEqual([4900, 1900]);
  expect(fixture.provider.calls).toHaveLength(1);
  expect(fixture.provider.calls[0]).toMatchObject({ amount: 1900, customerId: 'cust_default', paymentMethodId: 'pm_test_visa_4242' });
  expect((await page.changePlan(trial.body.id, 'unknown')).status).toBe(400);
  await expectApiAndRepositoryAgree(fixture, page, trial.body.id);
});

test('duplicate event delivery is audited without duplicate payment or invoice', async ({ fixture, billingPage: page }) => {
  const trial = await page.createSubscription(new SubscriptionBuilder().plan('pro').build());
  const invoice = (await page.getInvoices(trial.body.id)).body[0];
  const event = paymentEvent(page, trial.body.id, invoice, 'payment.succeeded', 'evt_once', '2026-03-02T00:00:00Z');
  expect((await page.sendSignedWebhook(event)).status).toBe(200);
  expect((await page.sendSignedWebhook(event)).body.duplicate).toBe(true);
  const saved = await records(fixture, trial.body.id);
  expect(saved.events).toHaveLength(1);
  expect(saved.deliveries).toHaveLength(1);
  expect(saved.deliveries[0].duplicate).toBe(true);
  expect(saved.invoices).toHaveLength(1);
  expect(saved.payments).toHaveLength(1);
  expect(saved.audit.some((item: any) => item.type === 'webhook.duplicate' && item.details.event_id === 'evt_once')).toBe(true);
  expect(fixture.provider.calls).toHaveLength(0);
});

test('same event ID with manipulated replay data remains a no-op and is audited', async ({ fixture, billingPage: page }) => {
  const trial = await page.createSubscription(new SubscriptionBuilder().plan('pro').build());
  const invoice = (await page.getInvoices(trial.body.id)).body[0];
  const original = paymentEvent(page, trial.body.id, invoice, 'payment.succeeded', 'evt_replay_tamper', '2026-03-04T00:00:00Z');
  await page.sendSignedWebhook(original);
  const alteredReplay = { ...original, amount: 1, invoice_id: 'inv_attacker' };
  expect((await page.sendSignedWebhook(alteredReplay)).body.duplicate).toBe(true);

  const saved = await records(fixture, trial.body.id);
  expect(saved.payments).toHaveLength(1);
  expect(saved.invoices).toHaveLength(1);
  expect(saved.events).toHaveLength(1);
  expect(saved.deliveries).toHaveLength(1);
  expect(saved.audit.some((item: any) => item.type === 'webhook.duplicate' && item.details.event_id === original.event_id)).toBe(true);
});

test('concurrent duplicates process one event and create one payment', async ({ fixture, billingPage: page }) => {
  const trial = await page.createSubscription(new SubscriptionBuilder().plan('pro').build());
  const invoice = (await page.getInvoices(trial.body.id)).body[0];
  const event = paymentEvent(page, trial.body.id, invoice, 'payment.succeeded', 'evt_parallel', '2026-03-03T00:00:00Z');
  const results = await Promise.all([page.sendSignedWebhook(event), page.sendSignedWebhook(event)]);
  expect(results.filter((result) => result.body.duplicate)).toHaveLength(1);
  expect((await records(fixture, trial.body.id)).payments).toHaveLength(1);
});

test('stale and late failures cannot regress success; canceled subscriptions ignore success', async ({ fixture, billingPage: page }) => {
  const trial = await page.createSubscription(new SubscriptionBuilder().plan('pro').build());
  const invoice = (await page.getInvoices(trial.body.id)).body[0];
  await page.sendSignedWebhook(paymentEvent(page, trial.body.id, invoice, 'payment.succeeded', 'evt_paid', '2026-04-02T00:00:00Z'));
  expect((await page.sendSignedWebhook(paymentEvent(page, trial.body.id, invoice, 'payment.failed', 'evt_old', '2026-04-01T00:00:00Z'))).body.stale).toBe(true);
  expect((await page.sendSignedWebhook(paymentEvent(page, trial.body.id, invoice, 'payment.failed', 'evt_late', '2026-04-03T00:00:00Z'))).body.applied).toBe(false);
  expect((await page.getSubscription(trial.body.id)).body.status).toBe('active');
  await page.cancelSubscription(trial.body.id);
  await page.sendSignedWebhook(paymentEvent(page, trial.body.id, invoice, 'payment.succeeded', 'evt_after_cancel', '2026-04-04T00:00:00Z'));
  expect((await page.getSubscription(trial.body.id)).body.status).toBe('canceled');
  expect((await records(fixture, trial.body.id)).payments).toHaveLength(1);
});

test('cancellation ignores later success, failure, and refund events', async ({ fixture, billingPage: page }) => {
  const active = await page.createSubscription(new SubscriptionBuilder().build());
  const invoice = (await page.getInvoices(active.body.id)).body[0];
  await page.cancelSubscription(active.body.id);

  const laterEvents: PaymentWebhook['type'][] = ['payment.succeeded', 'payment.failed', 'payment.refunded'];
  for (const [index, type] of laterEvents.entries()) {
    const result = await page.sendSignedWebhook(paymentEvent(page, active.body.id, invoice, type, `evt_canceled_${index}`, `2026-08-0${index + 1}T00:00:00Z`));
    expect(result.status).toBe(200);
    expect(result.body.applied).toBe(false);
  }

  expect((await page.getSubscription(active.body.id)).body.status).toBe('canceled');
  const saved = await records(fixture, active.body.id);
  expect(saved.payments).toHaveLength(1);
  expect(saved.invoices[0].status).toBe('paid');
  expect(saved.events).toHaveLength(3);
  await expectApiAndRepositoryAgree(fixture, page, active.body.id);
});

test('rejects forged signatures and malformed JSON before business processing', async ({ fixture, billingPage: page }) => {
  const trial = await page.createSubscription(new SubscriptionBuilder().plan('pro').build());
  const invoice = (await page.getInvoices(trial.body.id)).body[0];
  const event = paymentEvent(page, trial.body.id, invoice, 'payment.succeeded', 'evt_bad_sig', '2026-05-01T00:00:00Z');
  expect((await page.sendUnsignedWebhook(event)).status).toBe(401);
  expect((await page.sendMalformedWebhook()).status).toBe(400);
  expect((await records(fixture, trial.body.id)).events).toHaveLength(0);
  expect((await page.getSubscription(trial.body.id)).body.status).toBe('trialing');
});

test('refund updates payment history and repository state survives reopening', async ({ fixture, billingPage: page }) => {
  const trial = await page.createSubscription(new SubscriptionBuilder().plan('pro').build());
  const invoice = (await page.getInvoices(trial.body.id)).body[0];
  await page.sendSignedWebhook(paymentEvent(page, trial.body.id, invoice, 'payment.succeeded', 'evt_paid_refund', '2026-06-01T00:00:00Z'));
  await page.sendSignedWebhook(paymentEvent(page, trial.body.id, invoice, 'payment.refunded', 'evt_refund', '2026-06-02T00:00:00Z'));
  const saved = await records(fixture, trial.body.id);
  expect(saved.invoices[0].status).toBe('refunded');
  expect(saved.payments.map((payment: any) => payment.status)).toEqual(['succeeded', 'refunded']);
  expect(saved.audit.some((item: any) => item.type === 'payment.refunded')).toBe(true);
  const reopened = await fixture.reopenedRepository();
  expect(await reopened.snapshot()).toEqual(await fixture.repository.snapshot());
});

test('retry exhaustion cancels past_due', async ({ fixture, billingPage: page }) => {
  fixture.provider.enqueue({ status: 'declined' });
  const subscription = await page.createSubscription(new SubscriptionBuilder().build());
  expect(subscription.body.status).toBe('past_due');
  expect((await page.exhaustRetries(subscription.body.id)).status).toBe(200);
  expect((await page.getSubscription(subscription.body.id)).body.status).toBe('canceled');
});

test('plan changes and API cancellation are rejected from past_due and canceled states', async ({ fixture, billingPage: page }) => {
  fixture.provider.enqueue({ status: 'declined', reference: 'declined_for_invalid_transition' });
  const subscription = await page.createSubscription(new SubscriptionBuilder().build());
  expect(subscription.body.status).toBe('past_due');
  expect((await page.changePlan(subscription.body.id, 'pro')).status).toBe(409);
  expect((await page.cancelSubscription(subscription.body.id)).status).toBe(409);

  expect((await page.exhaustRetries(subscription.body.id)).status).toBe(200);
  expect((await page.changePlan(subscription.body.id, 'pro')).status).toBe(409);
  expect((await page.cancelSubscription(subscription.body.id)).status).toBe(409);
  expect((await page.getSubscription(subscription.body.id)).body.status).toBe('canceled');
  expect(fixture.provider.calls).toHaveLength(1);
  await expectApiAndRepositoryAgree(fixture, page, subscription.body.id);
});
