import { PGlite } from '@electric-sql/pglite';
import { type Db, migrate, type Sql } from './db';

// In-process Postgres (PGlite, real Postgres 18 compiled to WASM) for unit tests. One connection:
// statements are serialized, so concurrency is proven separately against a real server (test:pg).
export async function memoryDb(): Promise<Db & { pglite: PGlite }> {
  const pglite = new PGlite();
  const on = (c: Pick<PGlite, 'query'>): Sql => ({
    query: async <T>(text: string, params: unknown[] = []) => (await c.query<T>(text, params)).rows,
  });
  const db: Db & { pglite: PGlite } = {
    ...on(pglite),
    tx: (fn) => pglite.transaction((t) => fn(on(t))),
    async exec(sql) {
      await pglite.exec(sql);
    },
    close: () => pglite.close(),
    pglite,
  };
  await migrate(db);
  return db;
}
