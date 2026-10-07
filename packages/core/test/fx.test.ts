import { describe, expect, it } from 'vitest';
import { briefHash, buildBrief } from '../src/brief';
import { FX_QUOTE_MIN_REMAINING_MS } from '../src/constraints';
import { evaluate } from '../src/engine';
import { canonicalHash } from '../src/hash';
import { MandateError, parseMandate } from '../src/mandate';
import { signProposal } from '../src/proposal';
import { ActionIRSchema, type ActionFx, type ActionIR, type FxVerificationReport, type Mandate, type VerifiedReport } from '../src/schemas';
import { ADMIN_PKH, AGENT_PK, AGENT_SK, CFO_PKH, ENGINE_PK, NOW, state, usdm } from './fixtures';

// fx_lock: a Crebit rate lock proposed against a mandate with an fx block. Options only by default; forwards DENY.

const SOL = 'So11111111111111111111111111111111111111112';
const FX_CONSTRAINTS = [
  { id: 'fx_corridor', kind: 'fx_corridor_in', on_violation: 'DENY' },
  { id: 'fx_notional', kind: 'fx_notional_lte', on_violation: 'ESCALATE', approver: 'CFO' },
  { id: 'fx_tenor', kind: 'fx_tenor_lte', on_violation: 'DENY' },
  { id: 'fx_type', kind: 'fx_contract_type_in', on_violation: 'DENY' },
  { id: 'fx_fresh', kind: 'fx_quote_fresh', on_violation: 'DENY' },
  { id: 'fx_basis', kind: 'fx_basis_lte', on_violation: 'DENY' },
  { id: 'quote_facts', kind: 'verified_facts', source: 'crebit', on_violation: 'DENY' },
] as const;

export const FX_MANDATE_INPUT = {
  schema: 'mandate/v0.1',
  id: 'M-FX',
  version: 1,
  status: 'active',
  principal: { type: 'organization', id: 'acme', name: 'Acme Corp', cardano_key_hash: ADMIN_PKH },
  delegate: { type: 'agent', id: 'cfo-agent-01', public_key: `ed25519:${AGENT_PK}` },
  approvers: [{ role: 'CFO', cardano_key_hash: CFO_PKH }],
  authority_engine: { public_key: `ed25519:${ENGINE_PK}` },
  asset: { symbol: 'USDC', decimals: 6 },
  validity: { starts_at: '2026-10-06T00:00:00Z', expires_at: '2026-11-06T00:00:00Z' },
  delegation: { allowed: false },
  interrupt_budget: { per_day: 3 },
  fx: { corridors: ['USD-BRL'], max_notional: usdm(50_000), max_tenor_hours: 24 * 30, max_basis_bps: 50, counterparty: 'crebit' },
  constraints: [
    { id: 'purpose', kind: 'purpose_in', values: ['fx_hedge'], on_violation: 'DENY' },
    { id: 'action', kind: 'action_in', values: ['fx_lock'], on_violation: 'DENY' },
    { id: 'asset', kind: 'asset_eq', value: 'USDC', on_violation: 'DENY' },
    { id: 'counterparty', kind: 'counterparty_in', values: ['crebit'], on_violation: 'DENY' },
    { id: 'autonomous', kind: 'amount_lte', value: usdm(500), on_violation: 'ESCALATE', approver: 'CFO' },
    { id: 'hard_cap', kind: 'amount_lte', value: usdm(10_000), on_violation: 'DENY' },
    { id: 'daily_cap', kind: 'daily_spend_lte', value: usdm(10_000), on_violation: 'DENY' },
    { id: 'treasury_floor', kind: 'balance_after_gte', value: usdm(1_000), on_violation: 'DENY' },
    ...FX_CONSTRAINTS,
  ],
};
export const M_FX: Mandate = parseMandate(FX_MANDATE_INPUT);

export const QUOTE: ActionFx = {
  corridor: 'USD-BRL',
  direction: 'USD_TO_BRL',
  notional: usdm(20_000),
  tenor_hours: 24 * 7,
  contract_type: 'option',
  locked_rate: '5.42',
  premium: usdm(200),
  deposit: '0',
  quote_id: '22222222-2222-4222-8222-222222222222',
  quote_expires_at: new Date(NOW + 14 * 60_000).toISOString(),
  provider: 'crebit',
  market_rate_at_quote: '5.4180',
};

export function fxAction(patch: Partial<ActionFx> = {}, amount?: string): ActionIR {
  const fx = { ...QUOTE, ...patch };
  return ActionIRSchema.parse({
    schema: 'action-ir/v0.1',
    id: 'A-FX-1',
    mandate_id: 'M-FX',
    actor: 'cfo-agent-01',
    type: 'fx_lock',
    purpose: 'fx_hedge',
    counterparty: { id: 'crebit', display: 'Crebit (FX rate lock)' },
    amount: { value: amount ?? (BigInt(fx.premium) + BigInt(fx.deposit)).toString(), asset: 'USDC' },
    recipient: { chain: 'solana', address: SOL },
    source: { vault: 'acme-treasury' },
    fx,
    rationale: 'Hedge the BRL supplier payable due next week.',
    created_at: new Date(NOW - 5_000).toISOString(),
  });
}

export function fxReport(a: ActionIR, patch: Partial<FxVerificationReport> = {}, blockTimeMs = NOW - 30_000): VerifiedReport {
  const fx = a.fx!;
  const report: FxVerificationReport = {
    schema: 'fx-verification/v0.1',
    action_hash: canonicalHash(a),
    quote_id: fx.quote_id,
    quote_hash: 'ab'.repeat(32),
    verified_rate: fx.locked_rate,
    verified_premium: fx.premium,
    verified_deposit: fx.deposit,
    verified_expires_at: fx.quote_expires_at,
    market_rate: fx.market_rate_at_quote,
    basis_bps: 4,
    basis_source: 'quote',
    facts: { quote_exists: true, rate_match: true, premium_match: true, expiry_match: true, basis_ok: true },
    result: 'VERIFIED',
    reason: null,
    trigger_id: 'trg-1',
    ...patch,
  };
  return { report, report_hash: canonicalHash(report), block_time_ms: blockTimeMs };
}

const run = (a: ActionIR, v: VerifiedReport | null = null, st = state(5_000, 0, { anchor_version: 1 }), nowMs = NOW) =>
  evaluate({ mandate: M_FX, proposal: { action: a, agent_signature: signProposal(canonicalHash(a), AGENT_SK) }, state: st, verification: v, nowMs });

describe('fx_lock Action IR', () => {
  it('fx block exactly when type is fx_lock, direction must match corridor, amount = premium + deposit', () => {
    const a = fxAction();
    expect(ActionIRSchema.safeParse({ ...a, type: 'transfer' }).success).toBe(false);
    expect(ActionIRSchema.safeParse({ ...a, fx: undefined }).success).toBe(false);
    expect(ActionIRSchema.safeParse({ ...a, fx: { ...a.fx, direction: 'USD_TO_MXN' } }).success).toBe(false);
    expect(ActionIRSchema.safeParse({ ...a, amount: { ...a.amount, value: usdm(201) } }).success).toBe(false);
    const forward = fxAction({ contract_type: 'forward', deposit: usdm(1_000) });
    expect(forward.amount.value).toBe(usdm(1_200));
    expect(ActionIRSchema.safeParse({ ...a, recipient: { chain: 'solana', address: 'not-base58-0OIl' } }).success).toBe(false);
  });
});

describe('fx mandate rules', () => {
  it('an fx block needs every fx constraint and action_in fx_lock; fx constraints need an fx block', () => {
    const { fx: _fx, ...noBlock } = FX_MANDATE_INPUT;
    expect(() => parseMandate(noBlock)).toThrow(MandateError);
    const missing = { ...FX_MANDATE_INPUT, constraints: FX_MANDATE_INPUT.constraints.filter((c) => c.id !== 'fx_type') };
    expect(() => parseMandate(missing)).toThrow(/fx_contract_type_in/);
  });

  it('contract_types defaults to option only', () => {
    expect(M_FX.fx?.contract_types).toEqual(['option']);
  });
});

describe('fx constraints through the engine', () => {
  it('a fresh in-policy option quote needs verification, then ALLOW', () => {
    const a = fxAction();
    expect(run(a).outcome).toBe('NEEDS_VERIFICATION');
    const e = run(a, fxReport(a));
    expect(e).toMatchObject({ outcome: 'ALLOW', reason: null });
    expect(e.checks.find((c) => c.id === 'quote_facts')?.result).toBe('pass');
  });

  it('a forward is DENY by default: FX_CONTRACT_TYPE_NOT_AUTHORIZED', () => {
    const a = fxAction({ contract_type: 'forward', deposit: usdm(1_000) });
    expect(run(a)).toMatchObject({ outcome: 'DENY', reason: 'FX_CONTRACT_TYPE_NOT_AUTHORIZED' });
  });

  it('corridor, tenor, staleness deny; notional escalates', () => {
    expect(run(fxAction({ corridor: 'USD-MXN', direction: 'USD_TO_MXN' }))).toMatchObject({ outcome: 'DENY', reason: 'FX_CORRIDOR_NOT_AUTHORIZED' });
    expect(run(fxAction({ tenor_hours: 24 * 31 }))).toMatchObject({ outcome: 'DENY', reason: 'FX_TENOR_ABOVE_LIMIT' });
    const stale = fxAction({ quote_expires_at: new Date(NOW + FX_QUOTE_MIN_REMAINING_MS).toISOString() });
    expect(run(stale)).toMatchObject({ outcome: 'DENY', reason: 'FX_QUOTE_STALE' });
    const big = fxAction({ notional: usdm(60_000) });
    const e = run(big, fxReport(big));
    expect(e).toMatchObject({ outcome: 'ESCALATE' });
    expect(e.approvals_required).toEqual([{ constraint: 'fx_notional', approver: 'CFO', reason: 'FX_NOTIONAL_ABOVE_LIMIT' }]);
  });

  it('amount_lte applies to the funds leaving the treasury (the premium)', () => {
    const pricey = fxAction({ premium: usdm(600) });
    const e = run(pricey, fxReport(pricey));
    expect(e.outcome).toBe('ESCALATE');
    expect(e.approvals_required.map((x) => x.reason)).toEqual(['ABOVE_AUTONOMOUS_LIMIT']);
  });

  it('basis above the mandate limit is QUOTE_OFF_MARKET; a mismatched quote fails on its fact', () => {
    const a = fxAction();
    expect(run(a, fxReport(a, { basis_bps: 51 }))).toMatchObject({ outcome: 'DENY', reason: 'QUOTE_OFF_MARKET' });
    expect(run(a, fxReport(a, { basis_bps: null }))).toMatchObject({ outcome: 'DENY', reason: 'QUOTE_OFF_MARKET' });
    expect(run(a, fxReport(a, { verified_rate: '5.50' }))).toMatchObject({ outcome: 'DENY', reason: 'RATE_MISMATCH' });
    expect(run(a, fxReport(a, { verified_premium: usdm(199) }))).toMatchObject({ outcome: 'DENY', reason: 'PREMIUM_MISMATCH' });
    expect(run(a, fxReport(a, { quote_id: 'other' }))).toMatchObject({ outcome: 'DENY', reason: 'QUOTE_NOT_FOUND' });
    const mismatch = fxReport(a, { result: 'MISMATCH', reason: 'QUOTE_NOT_FOUND', facts: { quote_exists: false, rate_match: false, premium_match: false, expiry_match: false, basis_ok: false } });
    expect(run(a, mismatch)).toMatchObject({ outcome: 'DENY', reason: 'QUOTE_NOT_FOUND' });
  });

  it('an invoice report cannot satisfy fx facts', () => {
    const a = fxAction();
    const wrong = fxReport(a);
    const invoiceLike = { ...wrong, report: { ...wrong.report, schema: 'verification/v0.1' } } as unknown as VerifiedReport;
    // Not parseable as any report -> unusable -> still NEEDS_VERIFICATION, never a pass.
    expect(run(a, invoiceLike).outcome).toBe('NEEDS_VERIFICATION');
  });
});

describe('fx decision brief', () => {
  it('carries the quote and a will_happen naming the funding transfer; deterministic', () => {
    const a = fxAction({ notional: usdm(60_000) });
    const v = fxReport(a);
    const e = run(a, v);
    const input = { action: a, evaluation: e, mandate: M_FX, verification: { report: v.report, report_hash: v.report_hash, sepolia_tx: null }, bond: { amount: '5000000', asset: 'ADA' }, expires_at_ms: NOW + 3_600_000 };
    const b = buildBrief(input);
    expect(b.what.fx).toMatchObject({ corridor: 'USD-BRL', tenor_hours: 168, contract_type: 'option', locked_rate: '5.42', premium_display: '200 USDC', notional_display: '60000 USDC', quote_id: QUOTE.quote_id });
    expect(b.will_happen).toBe(
      `Transfer 200 USDC to the Crebit funding wallet assigned at lock to lock USD-BRL (USD_TO_BRL) at 5.42 for 168 hours (option, quote ${QUOTE.quote_id}, expires ${QUOTE.quote_expires_at}); Crebit pays the FX delta to ${SOL} at exercise. Nothing else is authorized.`,
    );
    expect(b.verified).toMatchObject({ result: 'VERIFIED', facts: { basis_ok: true } });
    expect(briefHash(buildBrief(input))).toBe(briefHash(b));
  });
});
