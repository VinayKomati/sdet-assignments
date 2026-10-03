'use strict';
const path = require('node:path');
const { BillingService } = require('./domain');
const { FileBillingRepository } = require('./repository');
const { createBillingApp } = require('./app');

// Deterministic local provider stub. In tests a recording provider is injected.
class LocalPaymentProvider { async charge(request) { return { status: 'succeeded', reference: `local_${request.invoiceId}` }; } }
const repository = new FileBillingRepository(process.env.BILLING_DATA_FILE || path.join(__dirname, 'data.json'));
const service = new BillingService(repository, new LocalPaymentProvider());
const port = process.env.BILLING_PORT || 5001;
repository.seedCustomer('cust_demo').then(() => createBillingApp(service).listen(port, () => console.log(`Billing fixture listening on ${port}`)));
