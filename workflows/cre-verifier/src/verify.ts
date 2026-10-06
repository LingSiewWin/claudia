// Deterministic invoice verification logic. No SDK imports, no clock, no randomness:
// the same Stripe response always yields the same tuple, report, and hash.
import { resultFromFacts } from '@authority/chainlink/codec';
import { canonicalHash, type VerificationReport } from '@authority/core';
import * as z from 'zod';

const U64 = 1n << 64n;
export const PAYOUT_CHAIN = 'cardano-preprod';
export const USDM_UNITS_PER_CENT = 10_000n;
const INVOICE_ID = /^in_[A-Za-z0-9]{1,61}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{1,60}$/;

export const TriggerRequestSchema = z.strictObject({
  trigger_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  action_hash: z.string().regex(/^[0-9a-f]{64}$/),
  invoice_id: z.string().regex(INVOICE_ID),
  customer_id: z.string().regex(CUSTOMER_ID),
  requested_amount: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/, { abort: true })
    .refine((s) => BigInt(s) < U64, 'must be < 2^64'),
  requested_currency: z.string().regex(/^[a-z]{3}$/),
  requested_recipient: z.string().min(1).max(200),
});
export type TriggerRequest = z.infer<typeof TriggerRequestSchema>;

export interface InvoiceTuple {
  id: string | null;
  customer: string | null;
  status: string | null;
  amount_due: string | null;
  currency: string | null;
  payout_address: string | null;
  vendor_id: string | null;
}

const NOT_FOUND: InvoiceTuple = {
  id: null,
  customer: null,
  status: null,
  amount_due: null,
  currency: null,
  payout_address: null,
  vendor_id: null,
};

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const pick = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);

// 404 means the invoice does not exist. Any other non-200 is "source unavailable" and throws,
// so no report is produced (the engine then reports VERIFICATION_UNAVAILABLE).
export function normalizeInvoice(httpStatus: number, body: unknown): InvoiceTuple {
  if (httpStatus === 404) return { ...NOT_FOUND };
  if (httpStatus !== 200) throw new Error(`stripe: unexpected HTTP ${httpStatus}`);
  const inv = record(body);
  const meta = record(inv.metadata);
  const amount = inv.amount_due;
  return {
    id: pick(inv.id, INVOICE_ID),
    customer: pick(inv.customer, CUSTOMER_ID),
    status: pick(inv.status, /^[a-z_]{1,32}$/),
    amount_due: typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? String(amount) : null,
    currency: pick(inv.currency, /^[a-z]{3}$/),
    payout_address: meta.payout_chain === PAYOUT_CHAIN ? pick(meta.payout_address, /^[a-z0-9_]{1,200}$/) : null,
    vendor_id: pick(meta.vendor_id, /^[A-Za-z0-9._-]{1,64}$/),
  };
}

export function compareFacts(t: InvoiceTuple, req: TriggerRequest): VerificationReport['facts'] {
  const exists = t.id !== null && t.id === req.invoice_id;
  return {
    exists,
    customer_match: exists && t.customer === req.customer_id,
    status_open: exists && t.status === 'open',
    amount_match:
      exists && t.amount_due !== null && BigInt(t.amount_due) * USDM_UNITS_PER_CENT === BigInt(req.requested_amount),
    currency_match: exists && t.currency === req.requested_currency,
    recipient_match: exists && t.payout_address === req.requested_recipient,
  };
}

export function buildReport(t: InvoiceTuple, req: TriggerRequest): { report: VerificationReport; report_hash: string } {
  const facts = compareFacts(t, req);
  const { result, reason } = resultFromFacts(facts);
  const units = t.amount_due === null ? null : BigInt(t.amount_due) * USDM_UNITS_PER_CENT;
  const report: VerificationReport = {
    schema: 'verification/v0.1',
    action_hash: req.action_hash,
    invoice_id: req.invoice_id,
    invoice_hash: canonicalHash(t),
    verified_amount: units === null || units >= U64 ? null : units.toString(),
    verified_currency: t.currency,
    verified_recipient: t.payout_address,
    status: t.status,
    facts,
    result,
    reason,
    trigger_id: req.trigger_id,
  };
  return { report, report_hash: canonicalHash(report) };
}
