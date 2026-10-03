'use strict';

const fs = require('node:fs/promises');

// Durable JSON-backed fixture repository. Methods mirror database operations so
// the service can later be wired to a production SQL implementation.
class FileBillingRepository {
  constructor(filePath) { this.filePath = filePath; this.tail = Promise.resolve(); }
  async read() {
    try { const data=JSON.parse(await fs.readFile(this.filePath, 'utf8')); for(const key of ['customers','subscriptions','invoices','payments','events','deliveries','audit'])data[key] ||= []; return data; }
    catch (error) { if (error.code === 'ENOENT') return { customers: [], subscriptions: [], invoices: [], payments: [], events: [], deliveries: [], audit: [] }; throw error; }
  }
  async write(data) {
    await fs.mkdir(require('node:path').dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(data, null, 2));
    await fs.rename(temporary, this.filePath);
  }
  async mutate(fn) { const data = await this.read(); const result = await fn(data); await this.write(data); return result; }
  async withLock(fn) {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  async saveSubscription(item) { return this.mutate(d => { const i=d.subscriptions.findIndex(x=>x.id===item.id); if(i<0)d.subscriptions.push(item);else d.subscriptions[i]=item; return item; }); }
  async seedCustomer(id) { return this.mutate(d => { if(!d.customers.includes(id))d.customers.push(id); return id; }); }
  async hasCustomer(id) { return (await this.read()).customers.includes(id); }
  async getSubscription(id) { return (await this.read()).subscriptions.find(x=>x.id===id) || null; }
  async saveInvoice(item) { return this.mutate(d => { const i=d.invoices.findIndex(x=>x.id===item.id); if(i<0)d.invoices.push(item);else d.invoices[i]=item; return item; }); }
  async getInvoice(id) { return (await this.read()).invoices.find(x=>x.id===id) || null; }
  async saveEvent(item) { return this.mutate(d => { if(!d.events.some(x=>x.event_id===item.event_id))d.events.push(item); return item; }); }
  async saveDelivery(item) { return this.mutate(d => { d.deliveries.push(item); return item; }); }
  async savePayment(item) { return this.mutate(d => { d.payments.push(item); return item; }); }
  async saveAudit(item) { return this.mutate(d => { d.audit.push(item); return item; }); }
  async getEvent(id) { return (await this.read()).events.find(x=>x.event_id===id) || null; }
  async latestEventForInvoice(id) { return (await this.read()).events.filter(x=>x.invoice_id===id).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0] || null; }
  async snapshot() { return this.read(); }
}

module.exports = { FileBillingRepository };
