import { bytesToHex } from '../src/bytes';
import { publicKeyFromSecret } from '../src/ed25519';
import { canonicalHash } from '../src/hash';
import type { ChainBinding } from '../src/issue';
import { parseMandate } from '../src/mandate';
import { signProposal } from '../src/proposal';
import type { ActionIR, ActionType, Mandate, State, VerificationReport, VerifiedReport } from '../src/schemas';
import { buildAddress } from './helpers/address-builder';

export const ENGINE_SK = new Uint8Array(32).fill(1);
export const AGENT_SK = new Uint8Array(32).fill(2);
export const ENGINE_PK = bytesToHex(publicKeyFromSecret(ENGINE_SK));
export const AGENT_PK = bytesToHex(publicKeyFromSecret(AGENT_SK));
export const CFO_PKH = '55'.repeat(28);
export const AWS_ADDR = buildAddress(0x60, new Uint8Array(28).fill(0xa1));
export const GLOBEX_ADDR = buildAddress(0x60, new Uint8Array(28).fill(0xb2));
export const ATTACKER_ADDR = buildAddress(0x60, new Uint8Array(28).fill(0xc3));
export const NFT_ADDR = buildAddress(0x60, new Uint8Array(28).fill(0xd4));
export const NOW = Date.parse('2026-10-07T03:00:00.000Z');

export const usdm = (dollars: number): string => (BigInt(Math.round(dollars * 100)) * 10_000n).toString();

export const M001_INPUT = {
  schema: 'mandate/v0.1',
  id: 'M-001',
  version: 3,
  status: 'active',
  principal: { type: 'organization', id: 'acme', name: 'Acme Corp' },
  delegate: { type: 'agent', id: 'cfo-agent-01', public_key: `ed25519:${AGENT_PK}` },
  approvers: [{ role: 'CFO', cardano_key_hash: CFO_PKH }],
  authority_engine: { public_key: `ed25519:${ENGINE_PK}` },
  asset: { symbol: 'USDM', decimals: 6 },
  validity: { starts_at: '2026-10-06T00:00:00Z', expires_at: '2026-11-06T00:00:00Z' },
  delegation: { allowed: false },
  constraints: [
    { id: 'purpose', kind: 'purpose_in', values: ['invoice_payment'], on_violation: 'DENY' },
    { id: 'action', kind: 'action_in', values: ['pay_invoice'], on_violation: 'DENY' },
    { id: 'asset', kind: 'asset_eq', value: 'USDM', on_violation: 'DENY' },
    { id: 'counterparty', kind: 'counterparty_in', values: ['aws', 'stripe'], on_violation: 'REQUIRE_APPROVAL', approver: 'CFO' },
    { id: 'autonomous', kind: 'amount_lte', value: usdm(10), on_violation: 'REQUIRE_APPROVAL', approver: 'CFO' },
    { id: 'hard_cap', kind: 'amount_lte', value: usdm(50), on_violation: 'DENY' },
    { id: 'daily_cap', kind: 'daily_spend_lte', value: usdm(50), on_violation: 'DENY' },
    { id: 'treasury_floor', kind: 'balance_after_gte', value: usdm(100), on_violation: 'DENY' },
    { id: 'invoice_facts', kind: 'verified_facts', source: 'stripe', on_violation: 'DENY' },
  ],
} as const;

export const M001: Mandate = parseMandate(M001_INPUT);

export const CHAIN: ChainBinding = {
  chainTag: 0,
  vaultHash: 'aa'.repeat(28),
  mandateRef: 'bb'.repeat(28),
  assetPolicy: 'ee'.repeat(28),
  assetName: '745553444d',
  assetSymbol: 'USDM',
};

export function state(balance: number, spent: number, overrides: Partial<State> = {}): State {
  return {
    vault_balance: usdm(balance),
    spent_today: usdm(spent),
    day_index: Math.floor(NOW / 86_400_000),
    last_nonce: '0',
    anchor_version: 3,
    anchor_status: 'active',
    observed_at_slot: 1,
    ...overrides,
  };
}

export interface ActionSpec {
  id: string;
  amount: number;
  type?: ActionType;
  purpose?: string;
  counterparty?: string;
  display?: string;
  recipient?: string;
  invoice?: string | null;
  rationale?: string;
}

export function action(s: ActionSpec): ActionIR {
  const invoice = s.invoice === undefined ? `INV-${s.id}` : s.invoice;
  return {
    schema: 'action-ir/v0.1',
    id: s.id,
    mandate_id: 'M-001',
    actor: 'cfo-agent-01',
    type: s.type ?? 'pay_invoice',
    purpose: s.purpose ?? 'invoice_payment',
    counterparty: { id: s.counterparty ?? 'aws', display: s.display ?? 'AWS (demo vendor)' },
    amount: { value: usdm(s.amount), asset: 'USDM' },
    recipient: { chain: 'cardano', address: s.recipient ?? AWS_ADDR },
    source: { vault: 'acme-treasury' },
    ...(invoice === null ? {} : { reference: { invoice_id: `in_${s.id}`, invoice_number: invoice } }),
    rationale: s.rationale ?? 'Invoice is open and matches an approved expense.',
    created_at: new Date(NOW - 5_000).toISOString(),
  };
}

export function propose(a: ActionIR, sk: Uint8Array = AGENT_SK): { action: ActionIR; agent_signature: string } {
  return { action: a, agent_signature: signProposal(canonicalHash(a), sk) };
}

type FactReason = NonNullable<VerificationReport['reason']>;
const FACT_KEY: Record<FactReason, keyof VerificationReport['facts']> = {
  INVOICE_NOT_FOUND: 'exists',
  CUSTOMER_MISMATCH: 'customer_match',
  INVOICE_NOT_OPEN: 'status_open',
  AMOUNT_MISMATCH: 'amount_match',
  CURRENCY_MISMATCH: 'currency_match',
  RECIPIENT_MISMATCH: 'recipient_match',
};

export function verificationReport(
  a: ActionIR,
  result: 'VERIFIED' | 'MISMATCH',
  reason: FactReason = 'RECIPIENT_MISMATCH',
): VerificationReport {
  const facts = { exists: true, customer_match: true, status_open: true, amount_match: true, currency_match: true, recipient_match: true };
  if (result === 'MISMATCH') facts[FACT_KEY[reason]] = false;
  return {
    schema: 'verification/v0.1',
    action_hash: canonicalHash(a),
    invoice_id: a.reference?.invoice_id ?? 'none',
    invoice_hash: 'ab'.repeat(32),
    verified_amount: a.amount.value,
    verified_currency: 'usd',
    verified_recipient: result === 'MISMATCH' && reason === 'RECIPIENT_MISMATCH' ? AWS_ADDR : a.recipient.address,
    status: 'open',
    facts,
    result,
    reason: result === 'VERIFIED' ? null : reason,
    trigger_id: `trigger-${a.id}`,
  };
}

export function verified(
  a: ActionIR,
  result: 'VERIFIED' | 'MISMATCH' = 'VERIFIED',
  reason?: FactReason,
  blockTimeMs: number = NOW - 30_000,
): VerifiedReport {
  const report = verificationReport(a, result, reason);
  return { report, report_hash: canonicalHash(report), block_time_ms: blockTimeMs };
}
