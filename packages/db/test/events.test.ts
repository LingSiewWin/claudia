import { canonicalJson, sha256Hex } from '@authority/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db';
import { appendEvent, chainHead, GENESIS_HASH, readRun, verifyChain } from '../src/events';
import { memoryDb } from '../src/testing';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-10-07T03:00:00.000Z');

let db: Awaited<ReturnType<typeof memoryDb>>;
beforeEach(async () => {
  db = await memoryDb();
});
afterEach(() => db.close());

const append = (run: string, type: string, payload: unknown, i: number, actionId: string | null = null) =>
  db.tx((q) => appendEvent(q, { run_id: run, action_id: actionId, type, payload }, T0 + i * 1000));

async function seed() {
  await append(RUN_A, 'RunStarted', { kind: 'stage', goal: 'pay invoices' }, 0);
  await append(RUN_B, 'RunStarted', { kind: 'masumi', goal: 'check' }, 1);
  await append(RUN_A, 'ActionProposed', { action_hash: 'dd'.repeat(32), amount: '8420000' }, 2, 'A-0001');
  await append(RUN_A, 'ActionDenied', { reason: 'PURPOSE_NOT_AUTHORIZED', layer: 'engine' }, 3, 'A-0001');
}

// What an admin with direct SQL access can do: the append-only trigger is not a security boundary.
async function asAdmin(sql: string, params: unknown[] = []) {
  await db.exec('alter table events disable trigger events_no_rewrite');
  await db.query(sql, params);
  await db.exec('alter table events enable trigger events_no_rewrite');
}

describe('event log hash chain', () => {
  it('links every event to the previous one: sha256(prev_hash || RFC 8785 body)', async () => {
    await seed();
    const a = await readRun(db, RUN_A);
    expect(a.map((e) => e.seq)).toEqual([1, 3, 4]);
    const first = a[0]!;
    expect(first.prev_hash).toBe(GENESIS_HASH);
    const body = { seq: 1, run_id: RUN_A, action_id: null, type: 'RunStarted', payload: { kind: 'stage', goal: 'pay invoices' }, created_at: '2026-10-07T03:00:00.000Z' };
    expect(first.hash).toBe(sha256Hex(new Uint8Array([...new Uint8Array(32), ...new TextEncoder().encode(canonicalJson(body))])));
    expect((await readRun(db, RUN_B))[0]!.prev_hash).toBe(first.hash);
    expect(await verifyChain(db)).toEqual({ ok: true, count: 4, head: (await chainHead(db)).hash });
    expect(await chainHead(db)).toEqual({ seq: 4, hash: (await readRun(db, RUN_A)).at(-1)!.hash });
    expect((await readRun(db, RUN_A, 3)).map((e) => e.seq)).toEqual([4]);
  });

  it('keeps numeric order past seq 9 (no text ordering of seq)', async () => {
    for (let i = 0; i < 12; i++) await append(RUN_A, 'Tick', { i }, i);
    expect((await readRun(db, RUN_A)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(await verifyChain(db)).toMatchObject({ ok: true, count: 12 });
  });

  it('stores hostile agent strings byte for byte (NUL, lone surrogate, emoji) and still verifies', async () => {
    const rationale = 'pay\u0000now \ud800 \u{1f4b8} "quoted" \\ back';
    const stored = await append(RUN_A, 'ActionProposed', { action: { rationale }, n: 1e21, z: -0 }, 0);
    const [read] = await readRun(db, RUN_A);
    expect(read).toEqual(stored);
    expect((read!.payload as { action: { rationale: string } }).action.rationale).toBe(rationale);
    expect((await verifyChain(db)).ok).toBe(true);
  });

  it('applies the schema again without changing anything', async () => {
    await seed();
    await migrate(db);
    expect(await verifyChain(db)).toMatchObject({ ok: true, count: 4 });
  });

  it('refuses updates, deletes and truncation from the application role', async () => {
    await seed();
    await expect(db.query(`update events set type = 'X' where seq = 2`)).rejects.toThrow('events are append-only');
    await expect(db.query('delete from events where seq = 2')).rejects.toThrow('events are append-only');
    await expect(db.query('truncate events')).rejects.toThrow('events are append-only');
  });
});

describe('tamper detection (database admin is malicious)', () => {
  it('an edited payload fails verification at exactly that seq', async () => {
    await seed();
    await asAdmin(`update events set payload = $1 where seq = 3`, [canonicalJson({ action_hash: 'dd'.repeat(32), amount: '84200000' })]);
    expect(await verifyChain(db)).toEqual({ ok: false, seq: 3, problem: 'hash does not match the event contents' });
  });

  it('a deleted event breaks the sequence', async () => {
    await seed();
    await asAdmin('delete from events where seq = 2');
    expect(await verifyChain(db)).toMatchObject({ ok: false, seq: 3, problem: 'expected seq 2' });
  });

  it('an edited timestamp, type or run id fails verification', async () => {
    for (const sql of [
      `update events set created_at = created_at + interval '1 second' where seq = 4`,
      `update events set type = 'ActionAllowed' where seq = 4`,
      `update events set run_id = '${RUN_B}' where seq = 4`,
    ]) {
      await db.close();
      db = await memoryDb();
      await seed();
      await asAdmin(sql);
      expect(await verifyChain(db)).toMatchObject({ ok: false, seq: 4 });
    }
  });

  it('a garbage payload is reported, not thrown', async () => {
    await seed();
    await asAdmin(`update events set payload = '{not json' where seq = 2`);
    expect(await verifyChain(db)).toEqual({ ok: false, seq: 2, problem: 'payload is not JSON' });
  });

  it('recomputing the stored chain up to an anchored seq gives the anchored hash, and nothing else does', async () => {
    await seed();
    const [e1, e3, e4] = await readRun(db, RUN_A);
    expect(await verifyChain(db, [{ seq: 3, hash: e3!.hash }, { seq: 1, hash: e1!.hash }])).toMatchObject({ ok: true });
    expect(await verifyChain(db, [{ seq: 3, hash: e4!.hash }])).toMatchObject({ ok: false, seq: 3 });
    expect(await verifyChain(db, [{ seq: 9, hash: e4!.hash }])).toMatchObject({ ok: false, seq: 9 });
  });

  it('a full rewrite that recomputes every later hash is caught by an anchored head', async () => {
    await seed();
    const last = (await readRun(db, RUN_A)).at(-1)!;
    const anchored = { seq: last.seq, hash: last.hash }; // the head a settlement committed on-chain
    const rows = await db.query<{ seq: string }>('select seq::text as seq from events order by seq');
    await db.exec('alter table events disable trigger events_no_rewrite');
    await db.query('delete from events');
    await db.exec('alter table events enable trigger events_no_rewrite');
    await append(RUN_A, 'RunStarted', { kind: 'stage', goal: 'pay invoices' }, 0);
    await append(RUN_B, 'RunStarted', { kind: 'masumi', goal: 'check' }, 1);
    await append(RUN_A, 'ActionProposed', { action_hash: 'dd'.repeat(32), amount: '84200000' }, 2, 'A-0001');
    await append(RUN_A, 'ActionDenied', { reason: 'PURPOSE_NOT_AUTHORIZED', layer: 'engine' }, 3, 'A-0001');
    expect(rows).toHaveLength(4);
    expect((await verifyChain(db)).ok).toBe(true);
    expect(await verifyChain(db, [anchored])).toEqual({
      ok: false,
      seq: 4,
      problem: `anchored head ${anchored.hash} is not the chain at seq 4`,
    });
  });
});
