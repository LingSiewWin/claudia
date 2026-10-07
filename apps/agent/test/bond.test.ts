import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalHash, signProposal } from '@authority/core';
import { buildAction, sourceVaultFor } from '@authority/llm';
import { lastResults, say, scriptedModel } from '@authority/llm/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthorityError, httpAuthority } from '../src/authority';
import { BondRefused, checkWithBond, costLine, DAY_MS, fakeBondPayer, newEscalationState, newSummary, priceOf } from '../src/bond';
import { runClaimed } from '../src/runtime';
import { clerk, tools } from '../src/testing';
import { b64json } from '../src/x402';
import { ADDR, AGENT_SK, ESCROW, fakeAuthority, M001, NOW } from './fake-authority';
import { deps } from './helpers';

const ACTION_HASH = 'ab'.repeat(32);
const PRICE = {
  schema: 'escalation-price/v0.1',
  approval_id: 'AP-7',
  network: 'cardano-preprod',
  asset: { policy_id: '', asset_name: '', symbol: 'ADA' },
  amount: '5000000',
  escrow_address: ESCROW,
  action_hash: ACTION_HASH,
  approver_key_hash: '55'.repeat(28),
  locked_until_ms: NOW + 3_600_000,
  interrupt_budget: { used: 1, per_day: 3 },
};
const REQUIRED = {
  x402Version: 2,
  error: 'escalation requires a bond',
  resource: { url: 'https://api.example.test/v1/authority/check', description: 'Human authority for action A-1' },
  accepts: [{ scheme: 'cardano-escrow', network: 'cardano-preprod', amount: '5000000', asset: 'lovelace', payTo: ESCROW, maxTimeoutSeconds: 3600, extra: PRICE }],
};
const BODY = { mandate_id: 'M-001', proposal: { action: { id: 'A-1' }, agent_signature: 'ab' }, execute: true, run_id: 'r' };

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});
async function serve(reply: (n: number, headers: IncomingHttpHeaders) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      seen.push({ headers: req.headers, body });
      const r = reply(seen.length, req.headers);
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers }).end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  close = () => new Promise<void>((r) => server.close(() => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
const ctx = (authority: Parameters<typeof checkWithBond>[0]['authority'], over: Partial<Parameters<typeof checkWithBond>[0]> = {}) => {
  const lines: Record<string, unknown>[] = [];
  const payer = fakeBondPayer();
  return {
    lines,
    payer,
    ctx: { authority, payer, maxBondLovelace: 10_000_000n, state: newEscalationState(), summary: newSummary(), now: () => NOW, sleep: async () => undefined, log: (l: Record<string, unknown>) => void lines.push(l), ...over },
  };
};

describe('x402 over HTTP', () => {
  it('decodes PAYMENT-REQUIRED on a 402, pays, retries with PAYMENT-SIGNATURE under the same key, and reads PAYMENT-RESPONSE', async () => {
    const { url, seen } = await serve((n, h) =>
      n === 1 || !h['payment-signature']
        ? { status: 402, body: REQUIRED, headers: { 'payment-required': b64json(REQUIRED) } }
        : {
            status: 200,
            body: { evaluation: { outcome: 'ESCALATE', reason: null }, approval_id: 'AP-7', receipt_id: 'R-1', receipt_hash: 'cc' },
            headers: { 'payment-response': b64json({ success: true, network: 'cardano-preprod', transaction: 'b001'.padEnd(64, 'f') }) },
          },
    );
    const api = httpAuthority({ url, key: 'k'.repeat(32) });
    const c = ctx(api);
    const reply = await checkWithBond(c.ctx, BODY, 'agent:r:A-1');
    expect(reply.evaluation.outcome).toBe('ESCALATE');
    expect(reply.settlement).toEqual({ success: true, network: 'cardano-preprod', transaction: 'b001'.padEnd(64, 'f') });
    expect(seen.map((s) => s.headers['idempotency-key'])).toEqual(['agent:r:A-1', 'agent:r:A-1']);
    expect(seen[0]!.headers['payment-signature']).toBeUndefined();
    expect(JSON.parse(Buffer.from(seen[1]!.headers['payment-signature'] as string, 'base64').toString())).toEqual({
      x402Version: 2,
      accepted: REQUIRED.accepts[0],
      payload: { approval_id: 'AP-7', tx_hash: 'b001'.padEnd(64, 'f'), output_index: 0 },
    });
    expect(seen.map((s) => s.body)).toEqual([JSON.stringify(BODY), JSON.stringify(BODY)]);
    expect(c.payer.calls.map((p) => [p.price.approval_id, p.accepted.payTo])).toEqual([['AP-7', ESCROW]]);
    expect(c.ctx.summary).toEqual({ escalations: 1, bonds_paid: 1, bonds_refunded: 0, budget_denials: 0 });
    expect(c.lines.map((l) => l.event)).toEqual(['bond_locked', 'bond_settled']);
  });

  it('falls back to the 402 body when the header is missing, and a 402 without a price is an ordinary error', async () => {
    const { url } = await serve((n) => (n === 1 ? { status: 402, body: REQUIRED } : { status: 402, body: { error: 'nope' } }));
    const api = httpAuthority({ url, key: 'k'.repeat(32) });
    const first = await api.check(BODY, 'k1').catch((e: unknown) => e as AuthorityError);
    expect(first).toBeInstanceOf(AuthorityError);
    expect((first as AuthorityError).paymentRequired?.accepts[0]?.scheme).toBe('cardano-escrow');
    const second = await api.check(BODY, 'k2').catch((e: unknown) => e as AuthorityError);
    expect((second as AuthorityError).paymentRequired).toBeNull();
    await expect(checkWithBond(ctx(api).ctx, BODY, 'k3')).rejects.toMatchObject({ status: 402, paymentRequired: null });
  });
});

describe('priceOf', () => {
  it('refuses a bond above AGENT_MAX_BOND_LOVELACE, a non-ADA asset, a wrong scheme or version, and a malformed price', () => {
    expect(priceOf(REQUIRED, 10_000_000n).price.amount).toBe('5000000');
    const refused = (r: unknown, max = 10_000_000n) => {
      try {
        priceOf(r as typeof REQUIRED, max);
      } catch (e) {
        return (e as BondRefused).reason;
      }
      return 'ACCEPTED';
    };
    expect(refused(REQUIRED, 4_999_999n)).toBe('BOND_ABOVE_MAX');
    expect(refused({ ...REQUIRED, accepts: [{ ...REQUIRED.accepts[0], asset: 'aa'.repeat(28) + '.55534d', extra: { ...PRICE, asset: { policy_id: 'aa'.repeat(28), asset_name: '55534d', symbol: 'USDM' } } }] })).toBe('BOND_ASSET_UNSUPPORTED');
    expect(refused({ ...REQUIRED, accepts: [{ ...REQUIRED.accepts[0], scheme: 'exact' }] })).toBe('BOND_PRICE_INVALID');
    expect(refused({ ...REQUIRED, x402Version: 1 })).toBe('BOND_PRICE_INVALID');
    expect(refused({ ...REQUIRED, accepts: [{ ...REQUIRED.accepts[0], extra: { ...PRICE, amount: '-1' } }] })).toBe('BOND_PRICE_INVALID');
    expect(refused({ ...REQUIRED, accepts: [{ ...REQUIRED.accepts[0], amount: '1' }] })).toBe('BOND_PRICE_INVALID');
  });
});

const escalating = (n: number) => ({ queue: Array.from({ length: n }, () => ({ kind: 'invoice' as const, invoice_number: 'INV-3822' })), messages: [] });

describe('bond payment in a run', () => {
  it('a bond above the limit is refused: no payment, no human, the model hears why and may stay within limits', async () => {
    const fake = fakeAuthority({ work: escalating(1), bondLovelace: '12000000' });
    const model = clerk({ gullible: false });
    const { deps: d, lines } = deps(fake, model);
    const result = await runClaimed(d, (await fake.client.claim())!);
    expect((d.payer as ReturnType<typeof fakeBondPayer>).calls).toHaveLength(0);
    expect(result.items[0]!.proposal).toBeNull();
    expect(lastResults(model.inputs.at(-1)!)[0]).toMatchObject({ is_error: true, content: expect.stringContaining('BOND_ABOVE_MAX: the escalation bond is 12 ADA, above this agent\'s limit of 10 ADA') });
    expect(fake.approvals.map((a) => a.status)).toEqual(['awaiting_bond']);
    expect(fake.events.map((e) => e.type)).toEqual(['BondRequired']);
    expect(result.summary).toEqual({ escalations: 1, bonds_paid: 0, bonds_refunded: 0, budget_denials: 0 });
    expect(lines.find((l) => l.event === 'bond_refused')).toMatchObject({ reason: 'BOND_ABOVE_MAX' });
  });

  it('never pays twice for one approval: a 402 repeated after payment re-presents the same bond', async () => {
    const fake = fakeAuthority({ work: escalating(1) });
    // The API has not seen the lock yet: the first two paid retries come back 402 again, then a 503, then it accepts.
    const check = fake.client.check;
    let paidSeen = 0;
    fake.client.check = async (body, key, payment) => {
      if (payment && ++paidSeen <= 2) return check(body, key, undefined);
      if (payment && paidSeen === 3) throw new AuthorityError(503, 'db hiccup', 1);
      return check(body, key, payment);
    };
    const c = ctx(fake.client);
    const action = buildAction(
      { type: 'pay_invoice', purpose: 'invoice_payment', counterparty_id: 'aws', counterparty_display: 'AWS (demo vendor)', amount: '18', recipient_address: ADDR.aws, invoice: { invoice_id: 'in_3822', invoice_number: 'INV-3822' }, rationale: 'open' },
      { id: 'A-1', mandate: M001, sourceVault: sourceVaultFor('M-001'), nowIso: new Date(NOW).toISOString() },
    );
    const body = { mandate_id: 'M-001', proposal: { action, agent_signature: signProposal(canonicalHash(action), AGENT_SK) }, execute: true, run_id: fake.runId };
    const reply = await checkWithBond(c.ctx, body, `agent:${fake.runId}:A-1`);
    expect(reply.evaluation.outcome).toBe('ESCALATE');
    expect(c.payer.calls).toHaveLength(1);
    expect(fake.checks.filter((x) => x.payment).map((x) => x.payment!.payload.tx_hash)).toEqual(['b001'.padEnd(64, 'f')]);
    expect(c.lines.map((l) => l.event)).toEqual(['bond_locked', 'bond_reused', 'bond_reused', 'bond_settled']);
    expect(c.ctx.summary).toEqual({ escalations: 1, bonds_paid: 1, bonds_refunded: 0, budget_denials: 0 });
  });

  it('gives up re-presenting a bond the API never accepts, without paying again', async () => {
    const fake = fakeAuthority({ work: escalating(1) });
    const check = fake.client.check;
    fake.client.check = (body, key) => check(body, key, undefined);
    const c = ctx(fake.client);
    const action = buildAction(
      { type: 'pay_invoice', purpose: 'invoice_payment', counterparty_id: 'aws', counterparty_display: 'AWS (demo vendor)', amount: '18', recipient_address: ADDR.aws, invoice: { invoice_id: 'in_3822', invoice_number: 'INV-3822' }, rationale: 'open' },
      { id: 'A-1', mandate: M001, sourceVault: sourceVaultFor('M-001'), nowIso: new Date(NOW).toISOString() },
    );
    const body = { mandate_id: 'M-001', proposal: { action, agent_signature: signProposal(canonicalHash(action), AGENT_SK) }, execute: true, run_id: fake.runId };
    await expect(checkWithBond(c.ctx, body, 'k')).rejects.toMatchObject({ reason: 'BOND_NOT_ACCEPTED' });
    expect(c.payer.calls).toHaveLength(1);
  });

  it('a failed lock is reported, not retried blindly, and leaves no bond on record', async () => {
    const fake = fakeAuthority({ work: escalating(1) });
    const { deps: d } = deps(fake, clerk({ gullible: false }), { payer: fakeBondPayer({ fail: new Error('insufficient tADA') }) });
    const result = await runClaimed(d, (await fake.client.claim())!);
    expect(result.items[0]!.proposal).toBeNull();
    expect(d.escalation!.paid.size).toBe(0);
    expect(result.summary).toEqual({ escalations: 1, bonds_paid: 0, bonds_refunded: 0, budget_denials: 0 });
  });
});

describe('interrupt budget', () => {
  it('four escalations in a day: three priced 402s are paid, the fourth is denied before any human, once logged', async () => {
    const fake = fakeAuthority({ work: escalating(4), cfo: () => 'decline' });
    const { deps: d, lines } = deps(fake, clerk({ gullible: false }));
    const result = await runClaimed(d, (await fake.client.claim())!);
    expect(result.items.map((i) => [i.proposal?.outcome, i.proposal?.reason, i.proposal?.resolution])).toEqual([
      ['ESCALATE', 'PRINCIPAL_DECLINED', 'declined'],
      ['ESCALATE', 'PRINCIPAL_DECLINED', 'declined'],
      ['ESCALATE', 'PRINCIPAL_DECLINED', 'declined'],
      ['DENY', 'INTERRUPT_BUDGET_EXHAUSTED', 'denied'],
    ]);
    expect(fake.events.filter((e) => e.type === 'ApprovalRequested')).toHaveLength(3);
    expect(fake.events.filter((e) => e.type === 'BondRequired')).toHaveLength(3);
    expect(result.summary).toEqual({ escalations: 3, bonds_paid: 3, bonds_refunded: 3, budget_denials: 1 });
    expect(lines.filter((l) => l.event === 'budget_exhausted')).toEqual([{ event: 'budget_exhausted', mandate_id: 'M-001', message: 'interrupt budget exhausted; no human paged' }]);
    expect(d.escalation!.exhausted.get('M-001')).toBe(Math.floor(NOW / DAY_MS));
  });

  it('once exhausted the agent pays no bond for that mandate until the next UTC day, then escalates again', async () => {
    let t = NOW;
    const fake = fakeAuthority({ work: escalating(1), cfo: () => 'decline', now: () => t });
    const c = ctx(fake.client, { now: () => t });
    c.ctx.state.exhausted.set('M-001', Math.floor(NOW / DAY_MS));
    const action = buildAction(
      { type: 'pay_invoice', purpose: 'invoice_payment', counterparty_id: 'aws', counterparty_display: 'AWS (demo vendor)', amount: '18', recipient_address: ADDR.aws, invoice: { invoice_id: 'in_3822', invoice_number: 'INV-3822' }, rationale: 'open' },
      { id: 'A-1', mandate: M001, sourceVault: sourceVaultFor('M-001'), nowIso: new Date(NOW).toISOString() },
    );
    const body = { mandate_id: 'M-001', proposal: { action, agent_signature: signProposal(canonicalHash(action), AGENT_SK) }, execute: true, run_id: fake.runId };
    await expect(checkWithBond(c.ctx, body, 'k1')).rejects.toMatchObject({ reason: 'INTERRUPT_BUDGET_EXHAUSTED' });
    expect(c.payer.calls).toHaveLength(0);
    t = NOW + DAY_MS;
    const reply = await checkWithBond(c.ctx, body, 'k2');
    expect([reply.evaluation.outcome, c.payer.calls.length]).toEqual(['ESCALATE', 1]);
  });

  it('the planner sees the bond and the remaining budget as deterministic text, in the prompt and in read_mandate', async () => {
    const fake = fakeAuthority({ work: escalating(2), cfo: () => 'decline' });
    const model = scriptedModel((input, call) => (call % 2 === 0 ? tools(['read_mandate', {}]) : say(lastResults(input)[0]!.content)));
    const { deps: d } = deps(fake, model);
    await runClaimed(d, (await fake.client.claim())!);
    const prompts = model.inputs.filter((_, i) => i % 2 === 0).map((i) => (i.messages[0]!.content[0] as { text: string }).text);
    expect(prompts[0]).toBe(
      "Today's queue, item 1 of 2: invoice INV-3822. " +
        costLine({ autonomousLimit: '10', asset: 'USDM', price: { amount: '5000000', asset: 'ADA' }, budget: { used: 0, per_day: 3 }, exhausted: false }),
    );
    expect(prompts[0]).toContain('locks 5 ADA from the agent wallet as a bond');
    expect(prompts[0]).toContain('Interrupt budget today: 3 of 3 left.');
    const mandateView = JSON.parse(lastResults(model.inputs[1]!)[0]!.content) as Record<string, unknown>;
    expect(mandateView).toMatchObject({ escalation_bond: '5 ADA', interrupt_budget: { used: 0, per_day: 3, availability: 'open' } });
  });

  it('an exhausted budget is spelled out so the model proposes within the autonomous limit', () => {
    const line = costLine({ autonomousLimit: '10', asset: 'USDM', price: { amount: '5000000', asset: 'ADA' }, budget: { used: 3, per_day: 3 }, exhausted: true });
    expect(line).toContain('Interrupt budget today: 0 of 3 left. Any proposal that needs approval will be denied without paging anyone');
    expect(costLine({ autonomousLimit: '10', asset: 'USDM', price: null, budget: null, exhausted: false })).toContain('locks a bond from the agent wallet');
  });
});
