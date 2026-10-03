import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, request, test as base, type APIRequestContext } from '@playwright/test';
import { BillingPage } from './page';

// The fixture service is JavaScript so the test harness can exercise its public HTTP API.
const { FileBillingRepository } = require('../billing/repository') as {
  FileBillingRepository: new (filePath: string) => any;
};
const { BillingService } = require('../billing/domain') as {
  BillingService: new (repository: any, provider: any) => any;
};
const { createBillingApp } = require('../billing/app') as {
  createBillingApp: (service: any, options: { webhookSecret: string }) => any;
};

export interface ChargeRequest {
  customerId: string;
  paymentMethodId: string;
  amount: number;
  currency: string;
  invoiceId: string;
  idempotencyKey: string;
}

export interface ChargeOutcome {
  status: 'succeeded' | 'declined' | 'timeout';
  reference?: string;
}

export class RecordingPaymentProvider {
  readonly calls: ChargeRequest[] = [];
  private readonly outcomes: ChargeOutcome[];

  constructor(outcomes: ChargeOutcome[] = []) { this.outcomes = [...outcomes]; }
  enqueue(outcome: ChargeOutcome): void { this.outcomes.push(outcome); }

  async charge(requestData: ChargeRequest): Promise<ChargeOutcome> {
    this.calls.push(requestData);
    const outcome = this.outcomes.shift() ?? {
      status: 'succeeded' as const,
      reference: `fake_${requestData.invoiceId}`,
    };
    if (outcome.status === 'timeout') {
      const error = new Error('provider timeout') as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      throw error;
    }
    return outcome;
  }
}

export class BillingFixture {
  readonly repository: any;
  readonly provider: RecordingPaymentProvider;
  readonly dataFile: string;
  readonly server: any;
  readonly api: APIRequestContext;

  private constructor(
    directory: string,
    dataFile: string,
    repository: any,
    provider: RecordingPaymentProvider,
    server: any,
    api: APIRequestContext,
  ) {
    this.directory = directory;
    this.dataFile = dataFile;
    this.repository = repository;
    this.provider = provider;
    this.server = server;
    this.api = api;
  }

  private readonly directory: string;

  static async start(outcomes: ChargeOutcome[] = []): Promise<BillingFixture> {
    const directory = await mkdtemp(join(tmpdir(), 'billing-sdet-'));
    const dataFile = join(directory, 'state.json');
    const repository = new FileBillingRepository(dataFile);
    for (const customer of ['cust_default', 'cust_001', 'cust_trial', 'cust_retry', 'cust_timeout', 'cust_trial_cancel']) {
      await repository.seedCustomer(customer);
    }
    const provider = new RecordingPaymentProvider(outcomes);
    const service = new BillingService(repository, provider);
    const server = createBillingApp(service, { webhookSecret: 'test_webhook_secret' }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const api = await request.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
    return new BillingFixture(directory, dataFile, repository, provider, server, api);
  }

  async close(): Promise<void> {
    await this.api.dispose();
    await new Promise<void>((resolve, reject) => this.server.close((error?: Error) => error ? reject(error) : resolve()));
    await rm(this.directory, { recursive: true, force: true });
  }

  async reopenedRepository(): Promise<any> {
    return new FileBillingRepository(this.dataFile);
  }
}

type BillingTestFixtures = {
  fixture: BillingFixture;
  billingPage: BillingPage;
};

export const test = base.extend<BillingTestFixtures>({
  fixture: async ({}, use) => {
    const fixture = await BillingFixture.start();
    try { await use(fixture); } finally { await fixture.close(); }
  },
  billingPage: async ({ fixture }, use) => {
    await use(new BillingPage(fixture.api));
  },
});

export { expect };
