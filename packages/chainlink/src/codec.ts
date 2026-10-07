// On-chain layout of verification reports in VerificationRegistry. Shared by the CRE workflow
// (encoder) and the engine-side reader (decoder) so both sides use one definition.
import { canonicalHash, type VerificationReport, VerificationReportSchema } from '@authority/core';
import { encodeAbiParameters, type Hex, hexToString, stringToHex } from 'viem';

type Facts = VerificationReport['facts'];
type FactReason = NonNullable<VerificationReport['reason']>;

export const FACT_KEYS = [
  'exists',
  'customer_match',
  'status_open',
  'amount_match',
  'currency_match',
  'recipient_match',
] as const satisfies readonly (keyof Facts)[];

export const FACT_REASONS = [
  'INVOICE_NOT_FOUND',
  'CUSTOMER_MISMATCH',
  'INVOICE_NOT_OPEN',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'RECIPIENT_MISMATCH',
] as const satisfies readonly FactReason[];

// Compile errors if a fact key or reason is missing from its code list.
type AssertNever<T extends never> = T;
export type _UncoveredFactKeys = AssertNever<Exclude<keyof Facts, (typeof FACT_KEYS)[number]>>;
export type _UncoveredReasons = AssertNever<Exclude<FactReason, (typeof FACT_REASONS)[number]>>;

export const RESULT_CODE = { VERIFIED: 1, MISMATCH: 2 } as const;

export const FIELDS_COMPONENTS = [
  { name: 'actionHash', type: 'bytes32' },
  { name: 'invoiceId', type: 'string' },
  { name: 'invoiceHash', type: 'bytes32' },
  { name: 'verifiedAmount', type: 'string' },
  { name: 'verifiedCurrency', type: 'string' },
  { name: 'verifiedRecipient', type: 'bytes' },
  { name: 'status', type: 'string' },
  { name: 'facts', type: 'uint8' },
  { name: 'result', type: 'uint8' },
  { name: 'reason', type: 'uint8' },
  { name: 'triggerId', type: 'string' },
] as const;

const STORED_COMPONENTS = [
  { name: 'fields', type: 'tuple', components: FIELDS_COMPONENTS },
  { name: 'blockTime', type: 'uint64' },
] as const;

export const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'latestReport',
    stateMutability: 'view',
    inputs: [{ name: 'actionHash', type: 'bytes32' }],
    outputs: [
      { name: 'reportHash', type: 'bytes32' },
      { name: 'stored', type: 'tuple', components: STORED_COMPONENTS },
    ],
  },
  {
    type: 'function',
    name: 'getReport',
    stateMutability: 'view',
    inputs: [{ name: 'reportHash', type: 'bytes32' }],
    outputs: [{ name: 'stored', type: 'tuple', components: STORED_COMPONENTS }],
  },
  {
    type: 'event',
    name: 'InvoiceVerified',
    inputs: [
      { name: 'actionHash', type: 'bytes32', indexed: true },
      { name: 'reportHash', type: 'bytes32', indexed: true },
      { name: 'result', type: 'uint8', indexed: false },
    ],
  },
] as const;

export interface StoredFields {
  actionHash: Hex;
  invoiceId: string;
  invoiceHash: Hex;
  verifiedAmount: string;
  verifiedCurrency: string;
  verifiedRecipient: Hex;
  status: string;
  facts: number;
  result: number;
  reason: number;
  triggerId: string;
}

// Facts in spec order; the first failing fact names the single reason.
export function resultFromFacts(facts: Facts): { result: 'VERIFIED' | 'MISMATCH'; reason: FactReason | null } {
  const failed = FACT_KEYS.findIndex((key) => !facts[key]);
  return failed === -1 ? { result: 'VERIFIED', reason: null } : { result: 'MISMATCH', reason: FACT_REASONS[failed]! };
}

// Nullable report fields travel as empty strings / empty bytes, so an empty non-null value
// cannot be represented and is rejected.
export function toStoredFields(r: VerificationReport): StoredFields {
  for (const k of ['verified_currency', 'verified_recipient', 'status'] as const) {
    if (r[k] === '') throw new RangeError(`${k} must not be empty`);
  }
  const reasonIdx = r.reason === null ? -1 : FACT_REASONS.indexOf(r.reason);
  if (r.reason !== null && reasonIdx === -1) throw new RangeError(`unknown reason ${r.reason}`);
  if (!(r.result in RESULT_CODE)) throw new RangeError(`unknown result ${r.result}`);
  return {
    actionHash: `0x${r.action_hash}`,
    invoiceId: r.invoice_id,
    invoiceHash: `0x${r.invoice_hash}`,
    verifiedAmount: r.verified_amount ?? '',
    verifiedCurrency: r.verified_currency ?? '',
    verifiedRecipient: r.verified_recipient === null ? '0x' : stringToHex(r.verified_recipient),
    status: r.status ?? '',
    facts: FACT_KEYS.reduce((mask, key, bit) => (r.facts[key] ? mask | (1 << bit) : mask), 0),
    result: RESULT_CODE[r.result],
    reason: reasonIdx + 1,
    triggerId: r.trigger_id,
  };
}

export function reportFromStored(f: StoredFields): VerificationReport {
  if (f.result !== RESULT_CODE.VERIFIED && f.result !== RESULT_CODE.MISMATCH) throw new RangeError(`result code ${f.result}`);
  if (!Number.isInteger(f.reason) || f.reason < 0 || f.reason > FACT_REASONS.length) throw new RangeError(`reason code ${f.reason}`);
  if (!Number.isInteger(f.facts) || f.facts < 0 || f.facts >= 1 << FACT_KEYS.length) throw new RangeError(`facts mask ${f.facts}`);
  const recipient = f.verifiedRecipient === '0x' ? null : hexToString(f.verifiedRecipient);
  if (recipient !== null && stringToHex(recipient) !== f.verifiedRecipient.toLowerCase()) {
    throw new RangeError('verified recipient is not canonical UTF-8');
  }
  const empty = (s: string) => (s === '' ? null : s);
  return {
    schema: 'verification/v0.1',
    action_hash: f.actionHash.slice(2).toLowerCase(),
    invoice_id: f.invoiceId,
    invoice_hash: f.invoiceHash.slice(2).toLowerCase(),
    verified_amount: empty(f.verifiedAmount),
    verified_currency: empty(f.verifiedCurrency),
    verified_recipient: recipient,
    status: empty(f.status),
    facts: Object.fromEntries(FACT_KEYS.map((key, bit) => [key, (f.facts & (1 << bit)) !== 0])) as Facts,
    result: f.result === RESULT_CODE.VERIFIED ? 'VERIFIED' : 'MISMATCH',
    reason: f.reason === 0 ? null : FACT_REASONS[f.reason - 1]!,
    trigger_id: f.triggerId,
  };
}

// The onReport payload: abi.encode(bytes32 reportHash, Fields fields).
export function encodeReportPayload(r: VerificationReport): { reportHash: string; payload: Hex } {
  VerificationReportSchema.parse(r);
  const reportHash = canonicalHash(r);
  const payload = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'tuple', components: FIELDS_COMPONENTS }],
    [`0x${reportHash}`, toStoredFields(r)],
  );
  return { reportHash, payload };
}
