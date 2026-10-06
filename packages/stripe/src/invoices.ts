import Stripe from 'stripe';

// Read-only view of the vendor billing network. The agent and the API use only this module,
// always with the restricted read key, so no code path here can write invoices.

/** 1 USD cent = 10_000 USDM base units (USDM has 6 decimals). */
export const USDM_UNITS_PER_CENT = 10_000n;

export function centsToUsdmUnits(cents: number): bigint {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`cents must be a non-negative integer, got ${cents}`);
  return BigInt(cents) * USDM_UNITS_PER_CENT;
}

export interface InvoiceSummary {
  id: string;
  /** Demo invoice number set by the vendor (metadata.invoice_number), e.g. "INV-3821". */
  number: string | null;
  customer: string | null;
  status: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  amount_due_cents: number;
  /** amount_due in USDM base units, decimal string (Action IR amount format). */
  amount_usdm: string;
  currency: string;
  /** ISO 8601 UTC, or null when the invoice has no due date. */
  due_date: string | null;
  memo: string | null;
  payout_chain: string | null;
  payout_address: string | null;
  cardano_tx_hash: string | null;
}

const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const INVOICE_ID = /^in_[A-Za-z0-9]{1,61}$/;

export function readOnlyStripe(key: string | undefined, config: Stripe.StripeConfig = {}): Stripe {
  if (!key?.startsWith('rk_test_')) throw new Error('read-only Stripe client needs a test-mode restricted key (rk_test_)');
  return new Stripe(key, { maxNetworkRetries: 2, ...config });
}

export function toSummary(invoice: Stripe.Invoice): InvoiceSummary {
  const meta = invoice.metadata ?? {};
  const pick = (key: string) => meta[key] ?? null;
  const customer = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? null);
  return {
    id: invoice.id,
    number: pick('invoice_number'),
    customer,
    status: invoice.status,
    vendor_id: pick('vendor_id'),
    vendor_name: pick('vendor_name'),
    amount_due_cents: invoice.amount_due,
    amount_usdm: centsToUsdmUnits(invoice.amount_due).toString(),
    currency: invoice.currency,
    due_date: invoice.due_date === null ? null : new Date(invoice.due_date * 1000).toISOString(),
    memo: invoice.description,
    payout_chain: pick('payout_chain'),
    payout_address: pick('payout_address'),
    cardano_tx_hash: pick('cardano_tx_hash'),
  };
}

export async function listOpenInvoices(stripe: Stripe, customerId: string): Promise<InvoiceSummary[]> {
  // A missing id would drop the filter and list every open invoice on the account.
  if (!CUSTOMER_ID.test(customerId)) throw new TypeError('customer id must look like cus_...');
  const invoices = await stripe.invoices
    .list({ customer: customerId, status: 'open', limit: 100 })
    .autoPagingToArray({ limit: 1000 });
  return invoices.map(toSummary);
}

/** Returns null only when Stripe says the invoice does not exist. Outages and permission errors throw. */
export async function getInvoice(stripe: Stripe, invoiceId: string): Promise<InvoiceSummary | null> {
  if (!INVOICE_ID.test(invoiceId)) throw new TypeError('invoice id must look like in_...');
  try {
    return toSummary(await stripe.invoices.retrieve(invoiceId));
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) return null;
    throw error;
  }
}
