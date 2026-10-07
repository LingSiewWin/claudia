import { briefHash, bytesToHex, EscalationPriceSchema, utf8ToBytes } from '@authority/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declineMessage } from '../src/approvals';
import { ADDR, action, AGENT_KEY, type Api, cfoWallet, inv, LAB_AGENT_SK, MASUMI_KEY, NOW, signed, startApi, usdm } from './harness';
import { WITNESS } from './stage';

// x402 escalation: ESCALATE is priced (402) before any human sees it; a locked bond buys one unit of the day's
// interrupt budget; the bond goes back to the agent on approval or a legitimate decline, to the sink when frivolous.

let api: Api;
let run: string;
beforeEach(async () => {
  api = await startApi();
  run = await api.agentRun();
  // Two more invoices above the 10 USDM autonomous limit, so four escalations exist on M-001.
  api.invoices.set('in_e1', { id: 'in_e1', number: 'INV-E-1', amount: usdm('12.00'), payout: ADDR.aws, status: 'open' });
  api.invoices.set('in_e2', { id: 'in_e2', number: 'INV-E-2', amount: usdm('11.00'), payout: ADDR.aws, status: 'open' });
});
afterEach(() => api.close());

const b64 = (s: string) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const GLOBEX = { id: 'E-G', invoice: inv('INV-G-0042'), counterparty: ['globex', 'Globex (demo vendor)'] as [string, string] };
const escalating = [
  { id: 'E-1', invoice: inv('INV-3822') },
  GLOBEX,
  { id: 'E-3', invoice: { id: 'in_e1', number: 'INV-E-1', amount: usdm('12.00'), payout: ADDR.aws, status: 'open' as const } },
  { id: 'E-4', invoice: { id: 'in_e2', number: 'INV-E-2', amount: usdm('11.00'), payout: ADDR.aws, status: 'open' as const } },
];
const body = (spec: (typeof escalating)[number]) => ({ mandate_id: 'M-001', proposal: signed(action(spec)), execute: true, run_id: run });
const inbox = async () => (await api.get('/v1/approvals?status=pending')).json.approvals as Array<{ approval_id: string }>;
const declineSig = async (id: string, reason: 'legitimate' | 'frivolous') => {
  const { wallet, address } = await cfoWallet();
  return { ...(await wallet.signData(bytesToHex(utf8ToBytes(declineMessage(id, reason))), address)), reason };
};

describe('402 gate', () => {
  it('ESCALATE with execute: 402, PAYMENT-REQUIRED header = body, approval awaiting_bond, BondRequired, inbox empty', async () => {
    const res = await api.check(body(escalating[0]!));
    expect(res.status).toBe(402);
    expect(b64(res.headers.get('payment-required')!)).toEqual(res.json);
    expect(res.json).toMatchObject({
      x402Version: 2,
      error: 'escalation requires a bond',
      resource: { url: 'https://api.test/v1/authority/check', description: 'Human authority for action E-1' },
    });
    const [accepted] = res.json.accepts;
    expect(accepted).toMatchObject({ scheme: 'cardano-escrow', network: 'cardano-preprod', amount: '5000000', asset: 'lovelace', maxTimeoutSeconds: 3600 });
    expect(accepted.payTo).toBe(api.cardano.port.bondAddresses().escrow);
    const price = EscalationPriceSchema.parse(accepted.extra);
    expect(price).toMatchObject({
      approval_id: 'AP-1',
      asset: { policy_id: '', asset_name: '', symbol: 'ADA' },
      amount: '5000000',
      escrow_address: accepted.payTo,
      approver_key_hash: (await cfoWallet()).pkh,
      locked_until_ms: NOW + 3_600_000,
      interrupt_budget: { used: 0, per_day: 3 },
    });
    expect(await api.db.query(`select status from approvals`)).toEqual([{ status: 'awaiting_bond' }]);
    expect(await inbox()).toEqual([]);
    const types = (await api.log(run)).map((e) => e.type);
    expect(types).toContain('BondRequired');
    expect(types).not.toContain('ApprovalRequested');
    expect((await api.get('/v1/approvals/AP-1')).json).toMatchObject({ approval_id: 'AP-1', status: 'awaiting_bond', brief: null, bond: { status: 'required', tx_hash: null } });
  });

  it('the same action again gets the same approval and price (one BondRequired); a different idempotency key or the same one', async () => {
    const first = await api.check(body(escalating[0]!), { idem: 'k1' });
    const again = await api.check(body(escalating[0]!), { idem: 'k2' });
    const replay = await api.check(body(escalating[0]!), { idem: 'k1' });
    expect(again.json.accepts[0].extra).toEqual(first.json.accepts[0].extra);
    expect(replay.status).toBe(402);
    expect((await api.db.query(`select id from approvals`)).length).toBe(1);
    expect((await api.log(run)).filter((e) => e.type === 'BondRequired')).toHaveLength(1);
  });

  it('an invalid proof is 402 again with the same price: wrong tx, short amount, another approval', async () => {
    const first = await api.check(body(escalating[0]!));
    const accepted = first.json.accepts[0];
    const price = accepted.extra;
    const wrongTx = api.paymentHeader(accepted, price, { tx_hash: 'ab'.repeat(32), output_index: 0 });
    const r1 = await api.check(body(escalating[0]!), { headers: { 'payment-signature': wrongTx } });
    expect(r1.status).toBe(402);
    expect(r1.json.accepts[0].extra).toEqual(price);
    const short = api.cardano.lockBond(price, { amount: 4_999_999n });
    const r2 = await api.check(body(escalating[0]!), { headers: { 'payment-signature': api.paymentHeader(accepted, price, short) } });
    expect(r2.status).toBe(402);
    const r3 = await api.check(body(escalating[0]!), { headers: { 'payment-signature': 'not-base64-json' } });
    expect(r3.status).toBe(402);
    const other = api.cardano.lockBond({ ...price, approval_id: 'AP-9' });
    const r4 = await api.check(body(escalating[0]!), { headers: { 'payment-signature': api.paymentHeader(accepted, { ...price, approval_id: 'AP-9' }, other) } });
    expect(r4.status).toBe(402);
    expect(await inbox()).toEqual([]);
  });

  it('a valid proof: BondLocked, brief built, ApprovalRequested with brief and bond, 200 with PAYMENT-RESPONSE', async () => {
    const first = await api.check(body(escalating[0]!), { idem: 'pay' });
    const accepted = first.json.accepts[0];
    const utxo = api.cardano.lockBond(accepted.extra);
    const res = await api.check(body(escalating[0]!), { idem: 'pay', headers: { 'payment-signature': api.paymentHeader(accepted, accepted.extra, utxo) } });
    expect(res.status).toBe(200);
    expect(res.json.evaluation.outcome).toBe('ESCALATE');
    expect(res.json.approval_id).toBe('AP-1');
    expect(res.json.authorization).toBeNull();
    expect(res.json.price).toBeUndefined();
    expect(res.json.brief).toMatchObject({
      schema: 'brief/v0.1',
      action_id: 'E-1',
      what: { amount: { display: '18 USDM' }, counterparty: { id: 'aws' } },
      escalation: { approver: 'CFO', because: [{ constraint: 'autonomous', reason: 'ABOVE_AUTONOMOUS_LIMIT' }] },
      verified: { result: 'VERIFIED' },
      cost: { bond: { amount: '5000000', asset: 'ADA' }, interrupt_budget: { used: 0, per_day: 3 } },
      expires_at_ms: NOW + 3_600_000,
    });
    expect(res.json.bond).toMatchObject({ schema: 'bond/v0.1', approval_id: 'AP-1', status: 'locked', tx_hash: utxo.tx_hash, output_index: 0, amount: '5000000', asset: 'ADA' });
    expect(b64(res.headers.get('payment-response')!)).toEqual({ success: true, network: 'cardano-preprod', transaction: utxo.tx_hash });
    const events = await api.log(run);
    expect(events.slice(-2).map((e) => e.type)).toEqual(['BondLocked', 'ApprovalRequested']);
    expect(events.at(-2)!.payload).toEqual({ approval_id: 'AP-1', tx_hash: utxo.tx_hash, output_index: 0, amount: '5000000', asset: 'ADA' });
    expect(events.at(-1)!.payload).toMatchObject({ approval_id: 'AP-1', approvals_required: [{ approver: 'CFO' }], brief: res.json.brief, bond: res.json.bond });
    const [row] = await api.db.query<{ status: string; brief_hash: string }>(`select status, brief_hash from approvals`);
    expect(row).toEqual({ status: 'pending', brief_hash: briefHash(res.json.brief) });
    expect(await inbox()).toMatchObject([{ approval_id: 'AP-1', brief: res.json.brief, bond: res.json.bond }]);
    const view = (await api.get('/v1/approvals/AP-1')).json;
    expect(view).toMatchObject({ approval_id: 'AP-1', status: 'pending', action: { id: 'E-1' }, evaluation: { outcome: 'ESCALATE' }, brief: res.json.brief, bond: res.json.bond });
    const receipt = (await api.get(`/v1/receipts/${res.json.receipt_id}`)).json.receipt;
    expect(receipt.approval).toEqual({ required: true, cfo_key_hash: null, brief_hash: row!.brief_hash, bond: { status: 'locked', tx_hash: utxo.tx_hash, outcome_tx_hash: null } });
  });

  it('Masumi (evaluate-only) gets the brief and a price quote: no approval, no bond, nothing to pay', async () => {
    const res = await api.check({ mandate_id: 'M-001', proposal: signed(action(escalating[0]!)), execute: false }, { key: MASUMI_KEY });
    expect(res.status).toBe(200);
    expect(res.json.evaluation.outcome).toBe('ESCALATE');
    expect(res.json.approval_id).toBeNull();
    expect(res.json.bond).toBeUndefined();
    expect(res.json.brief).toMatchObject({ schema: 'brief/v0.1', cost: { bond: { amount: '5000000', asset: 'ADA' } } });
    expect(EscalationPriceSchema.parse(res.json.price)).toMatchObject({ approval_id: 'quote', amount: '5000000', interrupt_budget: { used: 0, per_day: 3 } });
    expect(await api.db.query('select id from approvals')).toEqual([]);
    expect((await api.log(res.json.run_id)).map((e) => e.type)).not.toContain('BondRequired');
  });
});

describe('interrupt budget', () => {
  it('three locked bonds use the day; the fourth is DENY INTERRUPT_BUDGET_EXHAUSTED by the engine, no 402, inbox stays at three', async () => {
    for (const [i, spec] of escalating.slice(0, 3).entries()) {
      const res = await api.checkPaying(body(spec));
      expect(res.status).toBe(200);
      expect(res.json.brief.cost.interrupt_budget).toEqual({ used: i, per_day: 3 });
    }
    expect((await api.get('/v1/authority/CFO?mandate_id=M-001')).json).toEqual({
      approver: { role: 'CFO', key_hash: (await cfoWallet()).pkh },
      mandate_id: 'M-001',
      price: { amount: '5000000', asset: 'ADA' },
      interrupt_budget: { used: 3, per_day: 3 },
      escalations_today: 3,
      availability: 'budget_exhausted',
    });
    const fourth = await api.check(body(escalating[3]!));
    expect(fourth.status).toBe(200);
    expect(fourth.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INTERRUPT_BUDGET_EXHAUSTED' });
    expect(fourth.json.approval_id).toBeNull();
    expect((await api.log(run)).at(-1)).toMatchObject({ type: 'ActionDenied', action_id: 'E-4', payload: { reason: 'INTERRUPT_BUDGET_EXHAUSTED', layer: 'engine' } });
    expect((await api.db.query(`select id from approvals`)).length).toBe(3);
    expect(await inbox()).toHaveLength(3);
    // The next UTC day starts with a fresh budget.
    api.advance(86_400_000);
    expect((await api.get('/v1/authority/CFO?mandate_id=M-001')).json).toMatchObject({ interrupt_budget: { used: 0, per_day: 3 }, availability: 'open' });
  });

  it("two bonds racing for the day's last slot: the second is denied at claim time, never paged, refunded at locked_until", async () => {
    for (const spec of escalating.slice(0, 2)) expect((await api.checkPaying(body(spec))).status).toBe(200);
    // Both are priced while one slot is left; both bonds are locked before either proof is read back.
    const third = await api.check(body(escalating[2]!), { idem: 'p3' });
    const fourth = await api.check(body(escalating[3]!), { idem: 'p4' });
    expect([third.status, fourth.status]).toEqual([402, 402]);
    const [a3, a4] = [third.json.accepts[0], fourth.json.accepts[0]];
    const [u3, u4] = [api.cardano.lockBond(a3.extra), api.cardano.lockBond(a4.extra)];
    const port = api.cardano.port;
    const readBond = port.readBond.bind(port);
    let raced = false;
    port.readBond = async (price) => {
      // The third escalation settles while the fourth's bond is being read back: its engine evaluation saw used = 2.
      if (!raced && price.approval_id === 'AP-4') {
        raced = true;
        const settled = await api.check(body(escalating[2]!), { idem: 'p3', headers: { 'payment-signature': api.paymentHeader(a3, a3.extra, u3) } });
        expect(settled.status).toBe(200);
        expect(settled.json.approval_id).toBe('AP-3');
      }
      return readBond(price);
    };
    const res = await api.check(body(escalating[3]!), { idem: 'p4', headers: { 'payment-signature': api.paymentHeader(a4, a4.extra, u4) } });
    expect(raced).toBe(true);
    expect(res.status).toBe(200);
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INTERRUPT_BUDGET_EXHAUSTED' });
    expect(res.json.evaluation.checks.find((c: { id: string }) => c.id === 'interrupt_budget')).toMatchObject({ result: 'fail', detail: { used: 3, per_day: 3 } });
    expect(res.json.approval_id).toBeNull();
    expect(res.json.bond).toMatchObject({ approval_id: 'AP-4', status: 'locked', tx_hash: u4.tx_hash });
    expect((await api.log(run)).slice(-3).map((e) => [e.type, e.action_id])).toEqual([['BondLocked', 'E-4'], ['AuthorityEvaluated', 'E-4'], ['ActionDenied', 'E-4']]);
    expect(await inbox()).toHaveLength(3);
    expect((await api.get('/v1/approvals/AP-4')).json).toMatchObject({ status: 'awaiting_bond', bond: { status: 'locked', tx_hash: u4.tx_hash } });
    api.advance(api.bondLockMs + 1);
    await inbox();
    const view = (await api.get('/v1/approvals/AP-4')).json;
    expect(view).toMatchObject({ status: 'expired', bond: { status: 'refunded', tx_hash: u4.tx_hash } });
    expect((await api.log(run)).filter((e) => e.type === 'BondRefunded').map((e) => e.payload)).toContainEqual({ approval_id: 'AP-4', tx_hash: view.bond.outcome_tx_hash, reason: 'expired' });
  });

  it('priced but unpaid escalations consume nothing', async () => {
    for (const spec of escalating.slice(0, 3)) expect((await api.check(body(spec))).status).toBe(402);
    expect((await api.get('/v1/authority/CFO?mandate_id=M-001')).json).toMatchObject({ interrupt_budget: { used: 0 }, availability: 'open' });
    const paid = await api.checkPaying(body(escalating[3]!));
    expect(paid.status).toBe(200);
    expect(paid.json.brief.cost.interrupt_budget).toEqual({ used: 0, per_day: 3 });
  });

  it('approving the third escalation of the day still works: the gate does not count the approval itself', async () => {
    const ids: string[] = [];
    for (const spec of escalating.slice(0, 3)) ids.push((await api.checkPaying(body(spec))).json.approval_id);
    const res = await api.post(`/v1/approvals/${ids[2]}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.json.authorization.fields.requires_principal).toBe(true);
  });

  it('unknown role or mandate: 404; mandate_id required', async () => {
    expect((await api.get('/v1/authority/CEO?mandate_id=M-001')).status).toBe(404);
    expect((await api.get('/v1/authority/CFO?mandate_id=M-404')).status).toBe(404);
    expect((await api.get('/v1/authority/CFO')).status).toBe(400);
  });
});

describe('bond outcomes', () => {
  const requested = async (spec = escalating[0]!) => (await api.checkPaying(body(spec))).json as { approval_id: string; bond: { tx_hash: string } };

  it('approve: refund tx for the approver wallet; bond-submit confirms, BondRefunded approved', async () => {
    const { approval_id } = await requested();
    const approved = await api.post(`/v1/approvals/${approval_id}/approve`, {});
    expect(approved.json.bond_tx).toEqual({ unsigned_tx_cbor: expect.stringMatching(/^84a4/), tx_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(api.cardano.bondSpends.get(approved.json.bond_tx.tx_hash)!.outcome).toBe('refund');
    // same click again returns the same bond tx
    expect((await api.post(`/v1/approvals/${approval_id}/approve`, {})).json.bond_tx).toEqual(approved.json.bond_tx);
    expect((await api.post(`/v1/approvals/${approval_id}/bond-submit`, { tx_hash: 'cd'.repeat(32), cfo_witness_cbor: WITNESS })).status).toBe(409);
    const sub = await api.post(`/v1/approvals/${approval_id}/bond-submit`, { tx_hash: approved.json.bond_tx.tx_hash, cfo_witness_cbor: WITNESS });
    expect(sub.status).toBe(200);
    expect(sub.json.bond).toMatchObject({ status: 'refunded', outcome_tx_hash: approved.json.bond_tx.tx_hash });
    expect((await api.log(run)).at(-1)).toMatchObject({ type: 'BondRefunded', payload: { approval_id, tx_hash: approved.json.bond_tx.tx_hash, reason: 'approved' } });
    expect((await api.get(`/v1/approvals/${approval_id}`)).json.bond.status).toBe('refunded');
    expect((await api.post(`/v1/approvals/${approval_id}/bond-submit`, { tx_hash: approved.json.bond_tx.tx_hash, cfo_witness_cbor: WITNESS })).status).toBe(409);
  });

  it('decline legitimate: CFODeclined { reason }, refund, BondRefunded declined_legitimate', async () => {
    const { approval_id } = await requested(GLOBEX);
    const declined = await api.post(`/v1/approvals/${approval_id}/decline`, await declineSig(approval_id, 'legitimate'));
    expect(declined.status).toBe(200);
    expect(api.cardano.bondSpends.get(declined.json.bond_tx.tx_hash)!.outcome).toBe('refund');
    const sub = await api.post(`/v1/approvals/${approval_id}/bond-submit`, { tx_hash: declined.json.bond_tx.tx_hash, cfo_witness_cbor: WITNESS });
    expect(sub.status).toBe(200);
    const tail = (await api.log(run)).slice(-2);
    expect(tail.map((e) => e.type)).toEqual(['CFODeclined', 'BondRefunded']);
    expect(tail[0]!.payload).toEqual({ approval_id, reason: 'legitimate' });
    expect(tail[1]!.payload).toEqual({ approval_id, tx_hash: declined.json.bond_tx.tx_hash, reason: 'declined_legitimate' });
    expect(await inbox()).toEqual([]);
  });

  it('decline frivolous: capture to the sink, BondCaptured; the approver never receives it', async () => {
    const { approval_id } = await requested(GLOBEX);
    const declined = await api.post(`/v1/approvals/${approval_id}/decline`, await declineSig(approval_id, 'frivolous'));
    expect(declined.json.reason).toBe('frivolous');
    expect(api.cardano.bondSpends.get(declined.json.bond_tx.tx_hash)!.outcome).toBe('capture');
    const sub = await api.post(`/v1/approvals/${approval_id}/bond-submit`, { tx_hash: declined.json.bond_tx.tx_hash, cfo_witness_cbor: WITNESS });
    expect(sub.json.bond.status).toBe('captured');
    expect((await api.log(run)).at(-1)).toMatchObject({
      type: 'BondCaptured',
      payload: { approval_id, tx_hash: declined.json.bond_tx.tx_hash, sink_address: api.cardano.port.bondAddresses().sink },
    });
  });

  it('the reason is part of what the CFO signed: a mismatched or missing reason is 401', async () => {
    const { approval_id } = await requested(GLOBEX);
    const sig = await declineSig(approval_id, 'legitimate');
    expect((await api.post(`/v1/approvals/${approval_id}/decline`, { ...sig, reason: 'frivolous' })).status).toBe(401);
    const { reason: _r, ...noReason } = sig;
    expect((await api.post(`/v1/approvals/${approval_id}/decline`, noReason)).status).toBe(401);
    expect(await inbox()).toHaveLength(1);
  });

  it('expired: an hour later the approval expires and the bond is refunded without the approver (anyone-can-refund)', async () => {
    const { approval_id, bond } = await requested();
    const unpaid = await api.check(body(GLOBEX));
    expect(unpaid.status).toBe(402);
    api.advance(api.bondLockMs + 1);
    const pending = await inbox();
    expect(pending).toEqual([]);
    const view = (await api.get(`/v1/approvals/${approval_id}`)).json;
    expect(view.status).toBe('expired');
    expect(view.bond).toMatchObject({ status: 'refunded', tx_hash: bond.tx_hash, outcome_tx_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await api.log(run)).filter((e) => e.type === 'BondRefunded').map((e) => e.payload)).toEqual([{ approval_id, tx_hash: view.bond.outcome_tx_hash, reason: 'expired' }]);
    expect((await api.get('/v1/approvals/AP-2')).json).toMatchObject({ status: 'expired', bond: { status: 'expired', tx_hash: null } });
    expect((await api.post(`/v1/approvals/${approval_id}/approve`, {})).status).toBe(409);
  });
});

describe('metrics', () => {
  it('computed from the log: outcomes, interruptions per 100, bond lifecycle, budget denials', async () => {
    expect((await api.get('/v1/metrics?mandate_id=M-001')).json).toEqual({
      actions_evaluated: 0, allow: 0, deny: 0, escalate: 0, interruptions_per_100_actions: 0,
      bonds: { required: 0, locked: 0, refunded: 0, captured: 0 }, budget_exhausted: 0, median_decision_ms: null,
    });
    expect((await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'M-A', invoice: inv('INV-3821') })), execute: false, run_id: run })).json.evaluation.outcome).toBe('ALLOW');
    expect((await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'M-D', invoice: inv('INV-3823'), recipient: ADDR.attacker })), execute: false, run_id: run })).json.evaluation.outcome).toBe('DENY');
    expect((await api.check(body(escalating[2]!))).status).toBe(402); // priced, never paid
    const ids: string[] = [];
    for (const spec of escalating.slice(0, 2)) ids.push((await api.checkPaying(body(spec))).json.approval_id);
    const declined = await api.post(`/v1/approvals/${ids[1]}/decline`, await declineSig(ids[1]!, 'frivolous'));
    await api.post(`/v1/approvals/${ids[1]}/bond-submit`, { tx_hash: declined.json.bond_tx.tx_hash, cfo_witness_cbor: WITNESS });
    const approved = await api.post(`/v1/approvals/${ids[0]}/approve`, {});
    await api.post(`/v1/approvals/${ids[0]}/bond-submit`, { tx_hash: approved.json.bond_tx.tx_hash, cfo_witness_cbor: WITNESS });
    // The approve re-evaluation counts as a decision of the same action, so 5 actions: 1 allow, 1 deny, 3 escalate.
    expect((await api.get('/v1/metrics?mandate_id=M-001')).json).toEqual({
      actions_evaluated: 5,
      allow: 1,
      deny: 1,
      escalate: 3,
      interruptions_per_100_actions: 40,
      bonds: { required: 3, locked: 2, refunded: 1, captured: 1 },
      budget_exhausted: 0,
      median_decision_ms: 0,
    });
    expect((await api.get('/v1/metrics?mandate_id=M-LAB')).json.actions_evaluated).toBe(0);
    expect((await api.get('/v1/metrics')).status).toBe(400);
  });
});

describe('Attack Lab: escalation attacks', () => {
  const auth = { authorization: `Bearer ${AGENT_KEY}` };
  const labBody = (id: string, runId: string) => ({
    mandate_id: 'M-LAB',
    proposal: signed({ ...action({ id, invoice: inv('INV-L-0001'), counterparty: ['globex', 'Globex (demo vendor)'], mandateId: 'M-LAB' }), source: { vault: 'acme-lab' } }, LAB_AGENT_SK),
    execute: true,
    run_id: runId,
  });

  it('no_bond: the 402 is the stop; the inbox never sees it', async () => {
    const { run_id } = (await api.post('/v1/lab/attacks', { attack: 'no_bond' })).json;
    const claimed = (await api.post('/v1/agent/runs/claim', {}, auth)).json;
    expect(claimed).toMatchObject({ run_id, kind: 'lab', attack: 'no_bond' });
    const work = (await api.get(`/v1/agent/runs/${run_id}/work`, auth)).json;
    expect(work.queue).toEqual([{ kind: 'invoice', invoice_number: 'INV-L-0031' }, { kind: 'request', message_id: 'req-no_bond-1' }]);
    const res = await api.check(labBody('LAB-NB-1', run_id));
    expect(res.status).toBe(402);
    expect(await inbox()).toEqual([]);
    await api.post(`/v1/agent/runs/${run_id}/finish`, {}, auth);
    const events = await api.log(run_id);
    expect(events[1]).toMatchObject({ type: 'AttackStarted', payload: { attack: 'no_bond', mandate_id: 'M-LAB' } });
    expect(events.filter((e) => e.type === 'AttackResult').map((e) => e.payload)).toEqual([
      { attack: 'no_bond', stopped_by: 'engine', code: 'BOND_REQUIRED', funds_moved: '0', tx_hash: null },
    ]);
    expect(events.at(-1)!.type).toBe('RunCompleted');
  });

  it('escalation_spam: three priced and paid, the fourth denied by the engine before any human; inbox holds three', async () => {
    const { run_id } = (await api.post('/v1/lab/attacks', { attack: 'escalation_spam' })).json;
    await api.post('/v1/agent/runs/claim', {}, auth);
    expect((await api.get(`/v1/agent/runs/${run_id}/work`, auth)).json.queue.filter((w: { kind: string }) => w.kind === 'invoice')).toHaveLength(4);
    for (let i = 1; i <= 3; i++) {
      const res = await api.checkPaying(labBody(`LAB-ES-${i}`, run_id));
      expect(res.status).toBe(200);
      expect(res.json.approval_id).toBe(`AP-${i}`);
    }
    const fourth = await api.check(labBody('LAB-ES-4', run_id));
    expect(fourth.status).toBe(200);
    expect(fourth.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INTERRUPT_BUDGET_EXHAUSTED' });
    expect(await inbox()).toHaveLength(3);
    const events = await api.log(run_id);
    expect(events.filter((e) => e.type === 'ApprovalRequested')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'AttackResult').map((e) => e.payload)).toEqual([
      { attack: 'escalation_spam', stopped_by: 'engine', code: 'INTERRUPT_BUDGET_EXHAUSTED', funds_moved: '0', tx_hash: null },
    ]);
    expect((await api.get('/v1/metrics?mandate_id=M-LAB')).json).toMatchObject({ escalate: 3, deny: 1, budget_exhausted: 1, bonds: { required: 3, locked: 3 } });
    // M-001's budget is untouched by the lab.
    expect((await api.get('/v1/authority/CFO?mandate_id=M-001')).json.interrupt_budget.used).toBe(0);
  });
});
