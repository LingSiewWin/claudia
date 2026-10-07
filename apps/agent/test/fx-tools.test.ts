import { ActionIRSchema } from '@authority/core';
import { loadReferenceFixtures, type Quote } from '@authority/crebit';
import { describe, expect, it } from 'vitest';
import { fakeBondPayer, newEscalationState, newSummary } from '../src/bond';
import { CREBIT_NOT_CONFIGURED, type FxQuoteSource, fxLockAction } from '../src/fx';
import { agentTools, FX_TOOLS, type ItemContext } from '../src/tools';
import { AGENT_SK, fakeAuthority, M001, NOW } from './fake-authority';

// The fx tools: pricing reads Crebit; proposing turns a read-back quote into a signed fx_lock Action IR. With no
// keys both answer that keys are not configured. The reference quote is replayed documentation, never live data.

const SOL = 'So11111111111111111111111111111111111111112';
const REFERENCE = loadReferenceFixtures().find((f) => f.route === 'GET /fx/quotes/{quote_id}')!.body as Quote;
const quote = (patch: Partial<Quote> = {}): Quote => ({
  ...REFERENCE,
  direction: 'USD_TO_BRL',
  contract_type: 'option',
  notional_amount: '20000.00',
  premium_amount: '200.00',
  deposit_amount: null,
  chain: 'solana',
  payout_wallet_address: SOL,
  window_start: '2026-10-08T00:00:00Z',
  window_end: '2026-10-15T00:00:00Z',
  expires_at: new Date(NOW + 14 * 60_000).toISOString().replace('.000', ''),
  ...patch,
});

function fakeFx(quotes = new Map<string, Quote>([[REFERENCE.id, quote()]])): FxQuoteSource & { priced: unknown[] } {
  const priced: unknown[] = [];
  return {
    priced,
    async quote(args, customer) {
      priced.push({ args, customer });
      return quote({ notional_amount: args.notional_amount, direction: args.direction, contract_type: args.contract_type });
    },
    async get(id) {
      return quotes.get(id) ?? null;
    },
  };
}

async function ctx(fx: FxQuoteSource | null) {
  const fake = fakeAuthority({ mandate: M001 });
  const lines: Record<string, unknown>[] = [];
  const c: ItemContext = {
    authority: fake.client,
    invoices: fake.invoices,
    claim: (await fake.client.claim())!,
    work: { run_id: fake.runId, queue: [{ kind: 'fx_payable', corridor: 'USD-BRL', notional: '20000.00', due_at: '2026-10-15T00:00:00Z' }], messages: [] },
    mandate: M001,
    item: { kind: 'fx_payable', corridor: 'USD-BRL', notional: '20000.00', due_at: '2026-10-15T00:00:00Z' },
    actionId: 'A-fx-1',
    agentSecretKey: AGENT_SK,
    execute: false,
    now: () => NOW,
    sleep: async () => undefined,
    pollMs: 1,
    resolveTimeoutMs: 0,
    log: (l) => void lines.push(l),
    bonds: { authority: fake.client, payer: fakeBondPayer(), maxBondLovelace: 10_000_000n, state: newEscalationState(), summary: newSummary(), now: () => NOW, sleep: async () => undefined, log: () => undefined },
    cost: { line: '', pricing: null },
    out: { proposal: null },
    fx,
  };
  const tools = agentTools(c);
  const tool = (name: string) => tools.find((t) => t.def.name === name)!;
  return { c, fake, lines, tool };
}

describe('fx tools', () => {
  it('are listed and both refuse clearly without Crebit keys', async () => {
    const { tool } = await ctx(null);
    expect(FX_TOOLS.every((n) => tool(n))).toBe(true);
    await expect(tool('get_fx_quote').handle({ direction: 'USD_TO_BRL', notional_amount: '20000.00', tenor_hours: 168, payout_wallet_address: SOL })).rejects.toThrow(CREBIT_NOT_CONFIGURED);
    await expect(tool('propose_fx_lock').handle({ quote_id: REFERENCE.id, rationale: 'hedge' })).rejects.toThrow(CREBIT_NOT_CONFIGURED);
  });

  it('get_fx_quote prices under the principal as customer reference and returns the quote as strings', async () => {
    const fx = fakeFx();
    const { tool } = await ctx(fx);
    const out = JSON.parse(await tool('get_fx_quote').handle({ direction: 'USD_TO_BRL', notional_amount: '20000.00', tenor_hours: 168, payout_wallet_address: SOL }));
    expect(out).toMatchObject({ quote_id: REFERENCE.id, locked_rate: '5.42', premium_amount: '200.00', contract_type: 'option', chain: 'solana' });
    expect(fx.priced[0]).toMatchObject({ customer: { reference: 'acme', name: 'Acme Corp' }, args: { contract_type: 'option' } });
    await expect(tool('get_fx_quote').handle({ direction: 'USD_TO_XYZ' })).rejects.toThrow(/invalid input/);
  });

  it('fxLockAction takes every number from the quote', () => {
    const a = fxLockAction(quote(), { id: 'A-1', mandate: M001, sourceVault: 'acme-treasury', nowIso: new Date(NOW).toISOString(), rationale: 'hedge' });
    expect(ActionIRSchema.safeParse(a).success).toBe(true);
    expect(a).toMatchObject({ type: 'fx_lock', purpose: 'fx_hedge', counterparty: { id: 'crebit' }, amount: { value: '200000000', asset: 'USDM' }, recipient: { chain: 'solana', address: SOL } });
    expect(a.fx).toMatchObject({ corridor: 'USD-BRL', direction: 'USD_TO_BRL', notional: '20000000000', tenor_hours: 168, contract_type: 'option', locked_rate: '5.42', premium: '200000000', deposit: '0', quote_id: REFERENCE.id, market_rate_at_quote: null });
    const fwd = fxLockAction(quote({ contract_type: 'forward', deposit_amount: '1000.00' }), { id: 'A-2', mandate: M001, sourceVault: 'acme-treasury', nowIso: new Date(NOW).toISOString(), rationale: 'hedge' });
    expect(fwd.amount.value).toBe('1200000000');
  });

  it('propose_fx_lock submits a signed fx_lock proposal; the engine, not the tool, decides (M-001 allows no fx)', async () => {
    const { tool, fake, c } = await ctx(fakeFx());
    const reply = JSON.parse(await tool('propose_fx_lock').handle({ quote_id: REFERENCE.id, rationale: 'Hedge the BRL payable due next week.' }));
    expect(reply).toMatchObject({ action_id: 'A-fx-1', outcome: 'DENY', reason: 'PURPOSE_NOT_AUTHORIZED', result: 'denied' });
    const check = fake.checks.at(-1)!;
    expect(check.action).toMatchObject({ type: 'fx_lock', fx: { quote_id: REFERENCE.id } });
    expect(c.out.proposal?.action_id).toBe('A-fx-1');
    await expect(tool('propose_fx_lock').handle({ quote_id: REFERENCE.id, rationale: 'again' })).rejects.toThrow(/already has a proposal/);
    await expect((await ctx(fakeFx(new Map()))).tool('propose_fx_lock').handle({ quote_id: 'nope', rationale: 'x' })).rejects.toThrow(/no quote nope/);
  });
});
