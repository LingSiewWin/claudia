import { appendEvent, type Db, migrate, pgDb, verifyChain } from '@authority/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateNonce, reserveInvoice } from '../src/authorize';

// Real Postgres, real concurrency (PGlite serializes everything, so it cannot prove the locks).
// Runs only with PG_INTEGRATION=1 and PG_TEST_URL pointing at a throwaway database whose name ends in _test.
const url = process.env.PG_TEST_URL ?? '';
const enabled = process.env.PG_INTEGRATION === '1' && /_test(\?|$)/.test(url);

describe.skipIf(!enabled)('postgres: concurrent writers', () => {
  let db: Db;
  beforeAll(async () => {
    db = pgDb(url);
    await db.exec('drop schema if exists public cascade; create schema public;');
    await migrate(db);
  });
  afterAll(() => db.close());

  it('40 concurrent appends from 10 connections form one unbroken chain', async () => {
    const run = '44444444-4444-4444-8444-444444444444';
    const t0 = Date.parse('2026-10-07T03:00:00.000Z');
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => db.tx((q) => appendEvent(q, { run_id: run, action_id: null, type: 'Tick', payload: { i } }, t0 + i))),
    );
    expect(await verifyChain(db)).toMatchObject({ ok: true, count: 40 });
  });

  it('30 concurrent nonce allocations for one vault are all distinct and contiguous', async () => {
    const nonces = await Promise.all(Array.from({ length: 30 }, () => db.tx((q) => allocateNonce(q, 'vault-it', 0n))));
    expect(nonces.map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('20 concurrent reservations of one invoice: exactly one wins', async () => {
    const won = await Promise.all(Array.from({ length: 20 }, () => db.tx((q) => reserveInvoice(q, 'M-001', 'in_concurrent'))));
    expect(won.filter(Boolean)).toHaveLength(1);
  });
});
