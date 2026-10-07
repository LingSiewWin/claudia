import { type ActionFx, type ActionIR, canonicalHash, signProposal } from '@authority/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentMandate } from '../src/mandates';
import { createRun } from '../src/runs';
import { AGENT_SK, type Api, MASUMI_KEY, NOW, REFERENCE_QUOTE, startApi, usdm } from './harness';

// fx_lock through POST /v1/authority/check: quote verified against Crebit (fake read-back of the reference quote),
// 402 gate and brief as for invoices, no vault authorization on ALLOW, fail closed without keys.

const SOL = 'So11111111111111111111111111111111111111112';
const quoteFx = (patch: Partial<ActionFx> = {}): ActionFx => ({
  corridor: 'USD-BRL',
  direction: 'USD_TO_BRL',
  notional: usdm('20000'),
  tenor_hours: 24 * 7,
  contract_type: 'option',
  locked_rate: REFERENCE_QUOTE.locked_rate,
  premium: usdm('200'),
  deposit: '0',
  quote_id: REFERENCE_QUOTE.id,
  quote_expires_at: new Date(NOW + 14 * 60_000).toISOString().replace('.000', ''),
  provider: 'crebit',
  market_rate_at_quote: '5.4180',
  ...patch,
});
const fxAction = (id: string, patch: Partial<ActionFx> = {}): ActionIR => {
  const fx = quoteFx(patch);
  return {
    schema: 'action-ir/v0.1',
    id,
    mandate_id: 'M-FX',
    actor: 'cfo-agent-01',
    type: 'fx_lock',
    purpose: 'fx_hedge',
    counterparty: { id: 'crebit', display: 'Crebit (FX rate lock)' },
    amount: { value: (BigInt(fx.premium) + BigInt(fx.deposit)).toString(), asset: 'USDC' },
    recipient: { chain: 'solana', address: SOL },
    source: { vault: 'acme-treasury' },
    fx,
    rationale: 'Hedge the BRL supplier payable due next week.',
    created_at: new Date(NOW - 5_000).toISOString(),
  };
};
const signed = (a: ActionIR) => ({ action: a, agent_signature: signProposal(canonicalHash(a), AGENT_SK) });

describe('fx_lock authority check', () => {
  let api: Api;
  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(() => api.close());

  /** A claimed run under M-FX (the public run route starts only the stage mandate's queue). */
  async function fxRun(): Promise<string> {
    const row = (await currentMandate(api.db, 'M-FX'))!;
    return createRun(api.db, api.eng.log, { kind: 'stage', row, goal: 'FX hedge', status: 'active', vault: { balance: usdm('50000'), spent_today: '0' } });
  }

  it('an in-policy option quote is verified against Crebit and allowed without a vault authorization', async () => {
    const run_id = await fxRun();
    const res = await api.check({ mandate_id: 'M-FX', proposal: signed(fxAction('A-FX-1')), execute: true, run_id });
    expect(res.status).toBe(200);
    expect(res.json.evaluation).toMatchObject({ outcome: 'ALLOW', reason: null });
    expect(res.json.authorization).toBeNull();
    expect(res.json.verification).toMatchObject({ sepolia_tx: null, facts: { quote_exists: true, rate_match: true, premium_match: true, expiry_match: true, basis_ok: true } });
    const types = (await api.log(run_id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['QuoteVerificationStarted', 'QuoteVerificationCompleted', 'FxLockAllowed']));
    const receipt = await api.get(`/v1/receipts/${res.json.receipt_id}`);
    expect(receipt.json.receipt.verification).toMatchObject({ quote_id: REFERENCE_QUOTE.id, result: 'VERIFIED' });
    expect(receipt.json.receipt.verification.quote_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a forward is denied by the engine before any quote is read', async () => {
    const run_id = await fxRun();
    const res = await api.check({ mandate_id: 'M-FX', proposal: signed(fxAction('A-FX-2', { contract_type: 'forward', deposit: usdm('1000') })), execute: true, run_id });
    expect(res.status).toBe(200);
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'FX_CONTRACT_TYPE_NOT_AUTHORIZED' });
    expect((await api.log(run_id)).map((e) => e.type)).not.toContain('QuoteVerificationStarted');
  });

  it('a quote whose rate differs from the action is denied by the Crebit read-back', async () => {
    const run_id = await fxRun();
    const res = await api.check({ mandate_id: 'M-FX', proposal: signed(fxAction('A-FX-3', { locked_rate: '5.50' })), execute: true, run_id });
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'RATE_MISMATCH' });
    const denied = (await api.log(run_id)).find((e) => e.type === 'ActionDenied');
    expect(denied?.payload).toMatchObject({ reason: 'RATE_MISMATCH', layer: 'crebit' });
  });

  it('a notional above the mandate limit escalates: 402, then a brief that names the lock once the bond is read back', async () => {
    const run_id = await fxRun();
    const body = { mandate_id: 'M-FX', proposal: signed(fxAction('A-FX-4', { notional: usdm('60000') })), execute: true, run_id };
    const first = await api.check(body, { idem: 'fx:4' });
    expect(first.status).toBe(402);
    expect(first.json.accepts[0].extra.action_hash).toBe(canonicalHash(body.proposal.action));
    const paid = await api.checkPaying(body, { idem: 'fx:4' });
    expect(paid.status).toBe(200);
    expect(paid.json.evaluation.outcome).toBe('ESCALATE');
    expect(paid.json.approval_id).toMatch(/^AP-/);
    expect(paid.json.brief.what.fx).toMatchObject({ corridor: 'USD-BRL', contract_type: 'option', locked_rate: '5.42', notional_display: '60000 USDC', premium_display: '200 USDC' });
    expect(paid.json.brief.will_happen).toMatch(/^Transfer 200 USDC to the Crebit funding wallet assigned at lock to lock USD-BRL/);
    expect(paid.json.brief.escalation.because).toEqual([{ constraint: 'fx_notional', reason: 'FX_NOTIONAL_ABOVE_LIMIT' }]);
    // The quote was read once: the paid retry reused the report produced at pricing.
    const starts = (await api.log(run_id)).filter((e) => e.type === 'QuoteVerificationStarted');
    expect(starts).toHaveLength(1);
  });

  it('an unknown quote id is QUOTE_NOT_FOUND; an evaluate-only caller sees the same decision', async () => {
    const res = await api.check({ mandate_id: 'M-FX', proposal: signed(fxAction('A-FX-5', { quote_id: 'no-such-quote' })) }, { key: MASUMI_KEY });
    expect(res.status).toBe(200);
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'QUOTE_NOT_FOUND' });
  });

  it('without Crebit keys the check fails closed with 503 and names the env', async () => {
    api.setCrebitKeys(false);
    try {
      const res = await api.check({ mandate_id: 'M-FX', proposal: signed(fxAction('A-FX-6')) }, { key: MASUMI_KEY });
      expect(res.status).toBe(503);
      expect(res.json.error).toMatch(/Crebit keys not configured \(CREBIT_ENV, CREBIT_KEY_ID, CREBIT_KEY_SECRET\)/);
    } finally {
      api.setCrebitKeys(true);
    }
  });
});
