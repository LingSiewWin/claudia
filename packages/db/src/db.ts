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

interface ClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}
export interface PoolLike extends ClientLike {
  connect(): Promise<ClientLike & { release(err?: Error | boolean): void }>;
  end(): Promise<void>;
  on(event: 'error', listener: (err: Error & { code?: string }) => void): unknown;
}

// Error text from the driver may echo the connection string; never log it.
function safeMessage(err: Error & { code?: string }): string {
  const text = `${err.code ?? 'no code'}: ${err.message}`.replace(/postgres(ql)?:\/\/\S+/gi, '<url>');
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

export function pgDb(connectionString: string): Db {
  return poolDb(new pg.Pool({ connectionString, max: 10 }));
}

export function poolDb(pool: PoolLike): Db {
  // pg re-emits idle-client failures (server restart, dropped network) on the pool; without a listener they crash the process.
  pool.on('error', (err) => console.error(`postgres idle client error (${safeMessage(err)})`));
  const on = (c: ClientLike): Sql => ({
    query: async <T>(text: string, params: unknown[] = []) => (await c.query(text, params)).rows as T[],
  });
  return {
    ...on(pool),
    async tx(fn) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('begin');
        const out = await fn(on(client));
        await client.query('commit');
        return out;
      } catch (error) {
        await client.query('rollback').catch((rollbackError: unknown) => {
          broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        });
        throw error;
      } finally {
        // A connection whose rollback failed is in an unknown state: passing the error makes the pool destroy it.
        client.release(broken);
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
