import pg from 'pg';
import { SCHEMA } from './schema';

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Sql {
  /** Runs fn in one transaction. Inside fn use only the given Sql, never the outer Db (PGlite would deadlock, pg would escape the transaction). */
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T>;
  /** Multi-statement SQL without parameters (schema). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const on = (c: pg.Pool | pg.PoolClient): Sql => ({
    query: async <T>(text: string, params: unknown[] = []) => (await c.query(text, params)).rows as T[],
  });
  return {
    ...on(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(on(client));
        await client.query('commit');
        return out;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA);
}
