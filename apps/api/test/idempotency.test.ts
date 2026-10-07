import { memoryDb } from '@authority/db/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/http';
import { idempotent } from '../src/idempotency';

const raw = '{"action":"pay"}';
let db: Awaited<ReturnType<typeof memoryDb>>;
afterEach(() => db.close());

describe('idempotency attempt fence', () => {
  it('a request that loses the stale takeover cannot delete the successor row', async () => {
    db = await memoryDb();
    let releaseLoser!: () => void;
    const loserBlocked = new Promise<void>((resolve) => {
      releaseLoser = resolve;
    });
    let loserEntered!: () => void;
    const loserIn = new Promise<void>((resolve) => {
      loserEntered = resolve;
    });
    let issued = 0;

    const loser = idempotent(db, 'agent', 'pay-1', raw, async () => {
      loserEntered();
      await loserBlocked;
      throw new HttpError(503, 'dependency down');
    });
    await loserIn;
    await db.query(`update idempotency set created_at = now() - interval '10 minutes' where caller = 'agent' and key = 'pay-1'`);

    const successor = await idempotent(db, 'agent', 'pay-1', raw, async () => {
      issued += 1;
      return { status: 200, body: { authorization: 'Z-0001' } };
    });
    expect(successor).toEqual({ status: 200, body: { authorization: 'Z-0001' } });

    releaseLoser();
    await expect(loser).rejects.toMatchObject({ status: 503 });

    const rows = await db.query<{ status: number; response: string }>('select status, response from idempotency where caller = $1 and key = $2', [
      'agent',
      'pay-1',
    ]);
    expect(rows).toEqual([{ status: 200, response: JSON.stringify({ authorization: 'Z-0001' }) }]);

    const retry = await idempotent(db, 'agent', 'pay-1', raw, async () => {
      issued += 1;
      return { status: 200, body: { authorization: 'Z-0002' } };
    });
    expect(retry.body).toEqual({ authorization: 'Z-0001' });
    expect(issued).toBe(1);
  });

  it('a transient failure still removes this attempt, so the retry runs', async () => {
    db = await memoryDb();
    await expect(
      idempotent(db, 'agent', 'pay-2', raw, async () => {
        throw new HttpError(503, 'dependency down');
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await db.query('select key from idempotency')).toEqual([]);
    const retry = await idempotent(db, 'agent', 'pay-2', raw, async () => ({ status: 200, body: { authorization: 'Z-0001' } }));
    expect(retry.body).toEqual({ authorization: 'Z-0001' });
  });
});
