import { createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export interface CreateSubscription {
  customer_id: string;
  plan: string;
  payment_method_id: string;
}

export interface PaymentWebhook {
  event_id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'payment.refunded' | string;
  subscription_id: string;
  invoice_id: string;
  amount: number;
  currency: string;
  created_at: string;
  provider_reference?: string;
}

/** API page object: the assignment has no browser UI, so this models its HTTP resource. */
export class BillingPage {
  constructor(
    private readonly api: APIRequestContext,
    private readonly webhookSecret = 'test_webhook_secret',
  ) {}

  createSubscription(data: CreateSubscription): Promise<ApiResult> {
    return this.send('POST', '/subscriptions', data);
  }

  createWithoutBody(): Promise<ApiResult> {
    return this.send('POST', '/subscriptions');
  }

  getSubscription(id: string): Promise<ApiResult> {
    return this.send('GET', `/subscriptions/${id}`);
  }

  cancelSubscription(id: string): Promise<ApiResult> {
    return this.send('POST', `/subscriptions/${id}/cancel`, {});
  }

  exhaustRetries(id: string): Promise<ApiResult> {
    return this.send('POST', `/subscriptions/${id}/retries-exhausted`, {});
  }

  changePlan(id: string, plan: string): Promise<ApiResult> {
    return this.send('PATCH', `/subscriptions/${id}/plan`, { plan });
  }

  getInvoices(id: string): Promise<ApiResult> {
    return this.send('GET', `/subscriptions/${id}/invoices`);
  }

  sendSignedWebhook(event: PaymentWebhook): Promise<ApiResult> {
    return this.sendSignedPayload(event);
  }

  sendSignedPayload(payload: unknown): Promise<ApiResult> {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    return this.sendRawWebhook(rawBody, signature);
  }

  sendUnsignedWebhook(event: PaymentWebhook): Promise<ApiResult> {
    return this.sendRawWebhook(Buffer.from(JSON.stringify(event)), 'forged');
  }

  sendMalformedWebhook(rawBody = '{'): Promise<ApiResult> {
    const body = Buffer.from(rawBody);
    const signature = createHmac('sha256', this.webhookSecret).update(body).digest('hex');
    return this.sendRawWebhook(body, signature);
  }

  sendWebhookWithoutSignature(payload: unknown): Promise<ApiResult> {
    return this.sendRawWebhook(Buffer.from(JSON.stringify(payload)), undefined);
  }

  async sendTamperedWebhook(event: PaymentWebhook): Promise<ApiResult> {
    const original = Buffer.from(JSON.stringify(event));
    const signature = createHmac('sha256', this.webhookSecret).update(original).digest('hex');
    const tampered = Buffer.from(original.toString('utf8').replace(event.type, 'payment.failed'));
    return this.sendRawWebhook(tampered, signature);
  }

  buildWebhook(overrides: Partial<PaymentWebhook> = {}): PaymentWebhook {
    return {
      event_id: `evt_${randomUUID()}`,
      type: 'payment.succeeded',
      subscription_id: 'sub_missing',
      invoice_id: 'inv_missing',
      amount: 1900,
      currency: 'USD',
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  private async send(method: string, path: string, data?: object | Buffer): Promise<ApiResult> {
    const response = await this.api.fetch(path, { method, data });
    return { status: response.status(), body: await response.json().catch(() => null) };
  }

  private async sendRawWebhook(body: Buffer, signature?: string): Promise<ApiResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== undefined) headers['X-Provider-Signature'] = signature;
    const response = await this.api.post('/webhooks/payment-provider', {
      data: body,
      headers,
    });
    return { status: response.status(), body: await response.json().catch(() => null) };
  }
}

export class SubscriptionBuilder {
  private value: CreateSubscription = {
    customer_id: 'cust_default',
    plan: 'basic',
    payment_method_id: 'pm_test_visa_4242',
  };

  customer(id: string): this { this.value.customer_id = id; return this; }
  plan(name: string): this { this.value.plan = name; return this; }
  paymentMethod(id: string): this { this.value.payment_method_id = id; return this; }
  build(): CreateSubscription { return { ...this.value }; }
}
