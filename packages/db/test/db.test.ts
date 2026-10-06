import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PoolLike, poolDb } from '../src/db';

class FakeClient {
  readonly sent: string[] = [];
  released: Array<Error | boolean | undefined> = [];
  constructor(private readonly failOn: ReadonlySet<string> = new Set()) {}
  async query(text: string) {
    this.sent.push(text);
    if (this.failOn.has(text)) throw new Error(`${text} failed`);
    return { rows: [] };
  }
  release(err?: Error | boolean) {
    this.released.push(err);
  }
}

class FakePool extends EventEmitter {
  constructor(readonly client: FakeClient) {
    super();
  }
  async query() {
    return { rows: [] };
  }
  async connect() {
    return this.client;
  }
  async end() {}
}

afterEach(() => vi.restoreAllMocks());

describe('postgres pool adapter', () => {
  it('survives an idle-client error and logs a bounded message without the connection string', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = new FakePool(new FakeClient());
    poolDb(pool as PoolLike);
    const err = Object.assign(new Error(`connection to postgres://app:hunter2@db.internal:5432/x lost ${'x'.repeat(1000)}`), { code: '57P01' });
    expect(() => pool.emit('error', err)).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain('57P01');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('postgres://');
    expect(line.length).toBeLessThanOrEqual(300);
  });

  it('returns the client to the pool after a rolled-back transaction', async () => {
    const client = new FakeClient();
    const db = poolDb(new FakePool(client) as PoolLike);
    await expect(db.tx(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(client.sent).toEqual(['begin', 'rollback']);
    expect(client.released).toEqual([undefined]);
  });

  it('discards the connection when rollback itself fails, and still reports the original error', async () => {
    const client = new FakeClient(new Set(['rollback']));
    const db = poolDb(new FakePool(client) as PoolLike);
    await expect(db.tx(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(client.released).toHaveLength(1);
    expect(client.released[0]).toBeInstanceOf(Error);
    expect((client.released[0] as Error).message).toBe('rollback failed');
  });

  it('commits and releases normally on success', async () => {
    const client = new FakeClient();
    const db = poolDb(new FakePool(client) as PoolLike);
    expect(await db.tx(async () => 42)).toBe(42);
    expect(client.sent).toEqual(['begin', 'commit']);
    expect(client.released).toEqual([undefined]);
  });
});
