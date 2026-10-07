import { parseShelleyAddress } from '@authority/core';
import Stripe from 'stripe';
import { CUSTOMER_ID, type InvoiceSummary, toSummary } from './invoices';

// Vendor side of the demo billing network. Needs the full test-mode secret key, so only
// scripts/ (and tests) import it. The agent never does.

export type VendorId = 'aws' | 'globex';
export type DemoSet = 'stage' | 'masumi' | 'lab';
export type VendorAddresses = Record<VendorId, string>;

export const VENDOR_NAMES: Record<VendorId, string> = {
  aws: 'AWS (demo vendor)',
  globex: 'Globex (demo vendor)',
};

export interface DemoInvoice {
  number: string;
  set: DemoSet;
  vendor: VendorId;
  cents: number;
  memo: string;
}

export const DEMO_INVOICES: readonly DemoInvoice[] = [
  { number: 'INV-3821', set: 'stage', vendor: 'aws', cents: 842, memo: 'Cloud compute, September' },
  { number: 'INV-3822', set: 'stage', vendor: 'aws', cents: 1800, memo: 'Reserved capacity, Q4' },
  { number: 'INV-G-0042', set: 'stage', vendor: 'globex', cents: 500, memo: 'Integration consulting' },
  { number: 'INV-3825', set: 'stage', vendor: 'aws', cents: 6000, memo: 'Enterprise support, annual' },
  { number: 'INV-3823', set: 'stage', vendor: 'aws', cents: 400, memo: 'Data transfer, September' },
  { number: 'INV-3824', set: 'stage', vendor: 'aws', cents: 900, memo: 'Object storage, September' },
  { number: 'INV-M-0001', set: 'masumi', vendor: 'aws', cents: 842, memo: 'Cloud compute, October' },
  { number: 'INV-M-0002', set: 'masumi', vendor: 'aws', cents: 1800, memo: 'Reserved capacity, Q1' },
  { number: 'INV-M-0003', set: 'masumi', vendor: 'aws', cents: 400, memo: 'Data transfer, October' },
  { number: 'INV-L-0001', set: 'lab', vendor: 'aws', cents: 50, memo: 'Lab: recipient swap' },
  { number: 'INV-L-0002', set: 'lab', vendor: 'aws', cents: 50, memo: 'Lab: amount swap' },
  { number: 'INV-L-0003', set: 'lab', vendor: 'aws', cents: 50, memo: 'Lab: replay' },
  { number: 'INV-L-0004', set: 'lab', vendor: 'aws', cents: 50, memo: 'Lab: expired authorization' },
  { number: 'INV-L-0005', set: 'lab', vendor: 'aws', cents: 50, memo: 'Lab: revoked mandate' },
  { number: 'INV-L-0006', set: 'lab', vendor: 'aws', cents: 50, memo: 'Lab: prompt injection' },
  // Unlisted vendor at Stripe's minimum charge (0.50 USD, below the lab autonomous limit): each escalates on counterparty alone.
  { number: 'INV-L-0021', set: 'lab', vendor: 'globex', cents: 50, memo: 'Lab: escalation 1' },
  { number: 'INV-L-0022', set: 'lab', vendor: 'globex', cents: 50, memo: 'Lab: escalation 2' },
  { number: 'INV-L-0023', set: 'lab', vendor: 'globex', cents: 50, memo: 'Lab: escalation 3' },
  { number: 'INV-L-0024', set: 'lab', vendor: 'globex', cents: 50, memo: 'Lab: escalation 4' },
];

export const ACME_CUSTOMER = { name: 'Acme Corp', email: 'acme-ap@example.com' } as const;

export function invoiceMetadata(invoice: DemoInvoice, payoutAddress: string): Record<string, string> {
  return {
    invoice_number: invoice.number,
    demo_set: invoice.set,
    vendor_id: invoice.vendor,
    vendor_name: VENDOR_NAMES[invoice.vendor],
    payout_chain: 'cardano-preprod',
    payout_address: payoutAddress,
  };
}

export function vendorAddressesFromEnv(env: Record<string, string | undefined> = process.env): VendorAddresses {
  const read = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    if (parseShelleyAddress(value).network !== 0) throw new Error(`${name} must be a preprod address (addr_test1...)`);
    return value;
  };
  return { aws: read('DEMO_VENDOR_AWS_ADDRESS'), globex: read('DEMO_VENDOR_GLOBEX_ADDRESS') };
}

export function vendorStripe(key: string | undefined, config: Stripe.StripeConfig = {}): Stripe {
  if (!key?.startsWith('sk_test_')) throw new Error('vendor Stripe client needs the test-mode secret key (sk_test_)');
  return new Stripe(key, { maxNetworkRetries: 2, ...config });
}

export interface SeedPlan {
  keep: Stripe.Invoice[];
  voidIds: string[];
  deleteIds: string[];
  create: DemoInvoice[];
}

/** Pure reconciliation: which existing open/draft demo invoices to keep, void, or delete, and what to create. */
export function planSeed(
  existing: readonly Stripe.Invoice[],
  wanted: readonly DemoInvoice[],
  addresses: VendorAddresses,
  options: { sets: readonly DemoSet[]; reset?: boolean },
): SeedPlan {
  const plan: SeedPlan = { keep: [], voidIds: [], deleteIds: [], create: [] };
  const scoped = wanted.filter((w) => options.sets.includes(w.set));
  const kept = new Set<string>();
  for (const invoice of existing) {
    const number = invoice.metadata?.invoice_number;
    const set = invoice.metadata?.demo_set as DemoSet | undefined;
    if (!number || !set || !options.sets.includes(set)) continue;
    if (invoice.status === 'draft') {
      plan.deleteIds.push(invoice.id);
      continue;
    }
    if (invoice.status !== 'open') continue;
    const target = scoped.find((w) => w.number === number);
    if (!options.reset && target && !kept.has(number) && matches(invoice, target, addresses[target.vendor])) {
      kept.add(number);
      plan.keep.push(invoice);
    } else {
      plan.voidIds.push(invoice.id);
    }
  }
  plan.create = scoped.filter((w) => !kept.has(w.number));
  return plan;
}

function matches(invoice: Stripe.Invoice, target: DemoInvoice, payoutAddress: string): boolean {
  if (invoice.amount_due !== target.cents || invoice.currency !== 'usd') return false;
  const expected = invoiceMetadata(target, payoutAddress);
  return Object.entries(expected).every(([key, value]) => invoice.metadata?.[key] === value);
}

export async function ensureCustomer(stripe: Stripe, who: { name: string; email: string }): Promise<Stripe.Customer> {
  const found = await stripe.customers.list({ email: who.email, limit: 1 });
  return found.data[0] ?? (await stripe.customers.create({ name: who.name, email: who.email }));
}

export interface SeedResult {
  kept: InvoiceSummary[];
  created: InvoiceSummary[];
  voided: string[];
  deleted: string[];
}

export async function seedInvoices(
  stripe: Stripe,
  input: { customerId: string; invoices: readonly DemoInvoice[]; addresses: VendorAddresses; sets: readonly DemoSet[]; reset?: boolean },
): Promise<SeedResult> {
  if (!CUSTOMER_ID.test(input.customerId)) throw new TypeError('customer id must look like cus_...');
  const list = (status: 'open' | 'draft') =>
    stripe.invoices.list({ customer: input.customerId, status, limit: 100 }).autoPagingToArray({ limit: 1000 });
  const existing = [...(await list('open')), ...(await list('draft'))];
  const plan = planSeed(existing, input.invoices, input.addresses, { sets: input.sets, reset: input.reset ?? false });
  for (const id of plan.deleteIds) await stripe.invoices.del(id);
  for (const id of plan.voidIds) await stripe.invoices.voidInvoice(id);
  const created: InvoiceSummary[] = [];
  for (const invoice of plan.create) {
    created.push(toSummary(await createOpenInvoice(stripe, input.customerId, invoice, input.addresses[invoice.vendor])));
  }
  return { kept: plan.keep.map(toSummary), created, voided: plan.voidIds, deleted: plan.deleteIds };
}

async function createOpenInvoice(stripe: Stripe, customerId: string, invoice: DemoInvoice, payoutAddress: string) {
  const draft = await stripe.invoices.create({
    customer: customerId,
    currency: 'usd',
    collection_method: 'send_invoice',
    days_until_due: 30,
    auto_advance: false,
    description: invoice.memo,
    metadata: invoiceMetadata(invoice, payoutAddress),
  });
  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: draft.id,
    amount: invoice.cents,
    currency: 'usd',
    description: invoice.memo,
  });
  const open = await stripe.invoices.finalizeInvoice(draft.id, { auto_advance: false });
  if (open.status !== 'open' || open.amount_due !== invoice.cents) {
    throw new Error(`${invoice.number}: expected open with ${invoice.cents} cents, got ${open.status} with ${open.amount_due}`);
  }
  return open;
}

const TX_HASH = /^[0-9a-f]{64}$/;

/** Records a Cardano settlement on the invoice, then marks it paid out of band. Safe to retry with the same hash. */
export async function markPaidOutOfBand(stripe: Stripe, invoiceId: string, cardanoTxHash: string): Promise<Stripe.Invoice> {
  if (!TX_HASH.test(cardanoTxHash)) throw new TypeError('cardano tx hash must be 64 lowercase hex characters');
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const recorded = invoice.metadata?.cardano_tx_hash;
  if (invoice.status === 'paid') {
    if (recorded === cardanoTxHash) return invoice;
    throw new Error(`invoice ${invoiceId} is already paid${recorded ? ` by ${recorded}` : ''}`);
  }
  if (recorded && recorded !== cardanoTxHash) throw new Error(`invoice ${invoiceId} already records settlement ${recorded}`);
  if (invoice.status !== 'open') throw new Error(`invoice ${invoiceId} is ${invoice.status}, not open`);
  // Read-then-write, assumes one executor queue; add an idempotency key per tx hash if executors run concurrently.
  await stripe.invoices.update(invoiceId, { metadata: { cardano_tx_hash: cardanoTxHash } });
  return stripe.invoices.pay(invoiceId, { paid_out_of_band: true });
}
