import { eventHash, GENESIS_HASH, verifyChain } from '@authority/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CardanoError } from '../src/ports';
import { action, AGENT_KEY, type Api, inv, MASUMI_KEY, signed, startApi, usdm } from './harness';

let api: Api;
let run: string;
beforeEach(async () => {
  api = await startApi();
  run = await api.agentRun();
});
afterEach(() => api.close());

const pay = async (id: string, number = 'INV-3821') => {
  const res = await api.check({ mandate_id: 'M-001', proposal: signed(action({ id, invoice: inv(number) }, api.now())), execute: true, run_id: run });
  await api.executor.idle();
  return res;
};
const count = async (type: string) =>
  (await api.db.query<{ n: number }>('select count(*)::int as n from events where type = $1', [type]))[0]!.n;

describe('executor', () => {
  it('autonomous ALLOW settles, marks the invoice paid, and proves a settlement receipt', async () => {
    const res = await pay('A-1');
    const events = await api.log(run);
    expect(events.slice(-5).map((e) => e.type)).toEqual([
      'AuthorizationIssued',
      'TransactionBuilt',
      'TransactionSubmitted',
      'TransactionConfirmed',
      'ReceiptProven',
    ]);
    expect(api.chains.get(api.b001.vaultHash)!.balance).toBe(BigInt(usdm('126.58')));
    expect(api.settled).toEqual([{ invoiceId: 'in_3821', txHash: events.at(-2)!.payload.tx_hash }]);
    const proven = events.at(-1)!.payload;
    const bundle = (await api.get(`/v1/receipts/${proven.receipt_id}`)).json;
    expect(bundle.receipt_hash).toBe(proven.receipt_hash);
    expect(bundle.receipt.settlement).toMatchObject({ chain: 'cardano-preprod', tx_hash: events.at(-2)!.payload.tx_hash });
    expect(bundle.receipt.authorization.digest).toBe(res.json.authorization.digest_hex);
    expect(bundle.receipt.evidence.first_event_hash).toBe(events.find((e) => e.type === 'ActionProposed')!.hash);
    expect(bundle.receipt.evidence.last_event_hash).toBe(events.at(-2)!.hash);
    const listed = (await api.get('/v1/receipts?mandate_id=M-001')).json.receipts;
    expect(listed).toEqual([expect.objectContaining({ receipt_id: proven.receipt_id, action_id: 'A-1', amount: usdm('8.42'), counterparty: 'AWS (demo vendor)' })]);
  });

  it('settlement metadata commits log_head { seq, hash }: the event exists before the build and the chain recomputes to it', async () => {
    await pay('A-1');
    const built = (await api.log(run)).find((e) => e.type === 'TransactionBuilt')!;
    const metadata = api.cardano.built.at(-1)!.metadata;
    expect(metadata.log_head).toEqual(built.payload.log_head);
    expect(metadata.log_head.seq).toBe(built.seq - 1);
    // Recompute from genesis to seq using only the stored rows, exactly as an outside verifier would.
    const rows = await api.db.query<{ seq: string; run_id: string; action_id: string | null; type: string; payload: string; created_at: string }>(
      `select seq::text as seq, run_id::text as run_id, action_id, type, payload,
         to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
       from events where seq <= $1 order by events.seq`,
      [metadata.log_head.seq],
    );
    let head = GENESIS_HASH;
    for (const r of rows) head = eventHash(head, { seq: Number(r.seq), run_id: r.run_id, action_id: r.action_id, type: r.type, payload: JSON.parse(r.payload), created_at: r.created_at });
    expect(rows).toHaveLength(metadata.log_head.seq);
    expect(head).toBe(metadata.log_head.hash);
    expect(metadata.mandate).toBe('M-001@3');
    expect(metadata.auth).toBe((await api.log(run)).find((e) => e.type === 'AuthorizationIssued')!.payload.authorization.digest_hex);
    expect(await verifyChain(api.db, [metadata.log_head])).toMatchObject({ ok: true });
  });

  it('contention: retries with a fresh vault UTxO and the same authorization, never a new nonce', async () => {
    api.cardano.fault(new CardanoError('CONTENTION', 'vault input already spent'));
    await pay('A-1');
    expect(await count('AuthorizationIssued')).toBe(1);
    expect(await count('TransactionBuilt')).toBe(2);
    expect(await count('ReceiptProven')).toBe(1);
    const [n] = await api.db.query<{ counter: string }>('select counter::text as counter from nonces');
    expect(n!.counter).toBe('1');
  });

  it('a higher nonce settled first: the authorization is dead, nothing is re-signed', async () => {
    const res = await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') })), execute: false }, { key: MASUMI_KEY });
    api.cardano.contend(api.b001.vaultHash, 5n); // another release with nonce 5 settled in between
    const [row] = await api.db.query<{ id: string }>(`update authorizations set status = 'queued' returning id::text as id`);
    api.executor.enqueue(Number(row!.id));
    await api.executor.idle();
    const last = (await api.log(res.json.run_id)).at(-1)!;
    expect(last).toMatchObject({ type: 'TransactionRejected', payload: { invariant: 'R8' } });
    expect(api.cardano.built).toHaveLength(0);
    expect(await count('AuthorizationIssued')).toBe(1);
    expect(api.chains.get(api.b001.vaultHash)!.balance).toBe(BigInt(usdm('135')));
  });

  it('a vault rejection is an event with the invariant, and funds do not move', async () => {
    api.cardano.fault(new CardanoError('SCRIPT_FAILED', 'r12 ? False', 'R12', '84a4beef'));
    await pay('A-1');
    expect((await api.log(run)).at(-1)).toMatchObject({
      type: 'TransactionRejected',
      payload: { invariant: 'R12', error: 'r12 ? False', tx_body_cbor: '84a4beef' },
    });
    expect(api.chains.get(api.b001.vaultHash)!.balance).toBe(BigInt(usdm('135')));
  });

  it('an authorization about to expire is not submitted', async () => {
    const res = await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') })), execute: false }, { key: MASUMI_KEY });
    const [row] = await api.db.query<{ id: string }>('select id::text as id from authorizations');
    await api.db.query(`update authorizations set status = 'queued'`);
    api.advance(560_000);
    api.executor.enqueue(Number(row!.id));
    await api.executor.idle();
    const last = (await api.log(res.json.run_id)).at(-1)!;
    expect(last).toMatchObject({ type: 'TransactionRejected', payload: { invariant: 'EXPIRED' } });
    expect(api.cardano.built).toHaveLength(0);
  });

  it('paying the same invoice again: CRE sees it paid (INVOICE_NOT_OPEN)', async () => {
    await pay('A-1');
    const again = await pay('A-1-again');
    expect(again.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INVOICE_NOT_OPEN' });
  });

  it('re-evaluating after settlement with Stripe never marked: fresh CRE says open, the reservation says DENY', async () => {
    const original = api.invoices.get('in_3821')!;
    await pay('A-1');
    original.status = 'open'; // pretend Stripe never got the paid_out_of_band call
    const before = api.cre.calls.length;
    const again = await pay('A-1'); // the very same signed action, re-evaluated
    expect(api.cre.calls.length).toBe(before + 1); // a fresh verification, not the settled one's report
    expect(again.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INVOICE_NOT_OPEN' });
    expect(again.json.evaluation.checks.find((c: { id: string }) => c.id === 'invoice_facts').detail.holder).toBe('settled');
    expect(again.json.authorization).toBeNull();
    expect(await count('AuthorizationIssued')).toBe(1);
    expect(api.chains.get(api.b001.vaultHash)!.balance).toBe(BigInt(usdm('126.58')));
  });

  it('resume after a restart finishes a submitted release exactly once', async () => {
    await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') })), execute: false }, { key: MASUMI_KEY });
    await api.db.query(`update authorizations set status = 'submitted', tx_hash = $1, run_id = $2`, ['ab'.repeat(32), run]);
    await api.executor.resume();
    await api.executor.idle();
    expect(await count('ReceiptProven')).toBe(1);
    await api.executor.resume();
    await api.executor.idle();
    expect(await count('ReceiptProven')).toBe(1);
  });

  it('a finished run ends with exactly one RunCompleted, after its last release settles', async () => {
    await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') }, api.now())), execute: true, run_id: run });
    const finished = await api.post(`/v1/agent/runs/${run}/finish`, {}, { authorization: `Bearer ${AGENT_KEY}` });
    expect(finished.status).toBe(200);
    await api.executor.idle();
    const events = await api.log(run);
    expect(events.slice(-2).map((e) => e.type)).toEqual(['ReceiptProven', 'RunCompleted']);
    expect(await count('RunCompleted')).toBe(1);
    expect((await api.post(`/v1/agent/runs/${run}/finish`, {}, { authorization: `Bearer ${AGENT_KEY}` })).status).toBe(409);
    expect(await count('RunCompleted')).toBe(1);
  });
});
