import type { BillingFixture } from './fixture';
import type { BillingPage, PaymentWebhook } from './page';

export interface InvoiceRecord {
  id: string;
  amount: number;
  currency: string;
}

export function paymentEvent(
  page: BillingPage,
  subscriptionId: string,
  invoice: InvoiceRecord,
  type: PaymentWebhook['type'],
  eventId: string,
  time: string,
): PaymentWebhook {
  return page.buildWebhook({
    event_id: eventId,
    type,
    subscription_id: subscriptionId,
    invoice_id: invoice.id,
    amount: invoice.amount,
    currency: invoice.currency,
    created_at: time,
  });
}

export async function records(fixture: BillingFixture, subscriptionId: string) {
  const state = await fixture.repository.snapshot();
  return {
    subscription: state.subscriptions.find((item: any) => item.id === subscriptionId),
    invoices: state.invoices.filter((item: any) => item.subscription_id === subscriptionId),
    payments: state.payments.filter((item: any) => item.subscription_id === subscriptionId),
    events: state.events.filter((item: any) => item.subscription_id === subscriptionId),
    deliveries: state.deliveries.filter((item: any) => item.subscription_id === subscriptionId),
    audit: state.audit.filter((item: any) => item.subscription_id === subscriptionId),
  };
}

export async function expectApiAndRepositoryAgree(
  fixture: BillingFixture,
  page: BillingPage,
  id: string,
): Promise<any> {
  const api = await page.getSubscription(id);
  const stored = await fixture.repository.getSubscription(id);
  const { expect } = await import('@playwright/test');
  expect(api.body).toEqual(stored);
  return stored;
}
