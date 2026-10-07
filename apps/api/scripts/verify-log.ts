// Verifies the evidence log: recomputes the hash chain and checks that every settlement's on-chain log_head
// (tx metadata label 1694, read from Koios, not from our database) is still in the chain.
// Usage: pnpm --filter @authority/api verify-log [--tamper-demo <seq>]
// --tamper-demo edits one event inside a transaction, shows the failure, and rolls back (nothing is changed).
import { type ChainHead, type Db, pgDb, type Sql, verifyChain } from '@authority/db';

const KOIOS = process.env.KOIOS_URL ?? 'https://preprod.koios.rest/api/v1';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db: Db = pgDb(url);

async function anchoredHeads(q: Sql): Promise<Array<{ tx: string; head: ChainHead }>> {
  const rows = await q.query<{ body: string }>(`select body from receipts where kind = 'settlement' order by receipts.id`);
  const out: Array<{ tx: string; head: ChainHead }> = [];
  for (const r of rows) {
    const tx = (JSON.parse(r.body) as { settlement: { tx_hash: string } }).settlement.tx_hash;
    const res = await fetch(`${KOIOS}/tx_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _tx_hashes: [tx], _inputs: true, _scripts: true, _metadata: true }),
    });
    const [info] = (await res.json()) as Array<{ metadata: Record<string, { log_head?: { seq?: unknown; hash?: unknown } }> | null }>;
    const head = info?.metadata?.['1694']?.log_head;
    if (typeof head?.hash !== 'string' || !Number.isSafeInteger(Number(head.seq))) {
      throw new Error(`settlement ${tx} has no log_head { seq, hash } in metadata 1694`);
    }
    out.push({ tx, head: { seq: Number(head.seq), hash: head.hash } });
  }
  return out;
}

const heads = await anchoredHeads(db);
for (const h of heads) console.log(`anchored head seq ${h.head.seq} ${h.head.hash} in tx ${h.tx}`);
console.log(JSON.stringify(await verifyChain(db, heads.map((h) => h.head))));

const flag = process.argv.indexOf('--tamper-demo');
if (flag !== -1) {
  const seq = Number(process.argv[flag + 1]);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('--tamper-demo needs an event seq');
  await db
    .tx(async (q) => {
      await q.query('alter table events disable trigger events_no_rewrite');
      await q.query(`update events set payload = $1 where seq = $2`, ['{"tampered":true}', seq]);
      console.log(`after editing seq ${seq}: ${JSON.stringify(await verifyChain(q, heads.map((h) => h.head)))}`);
      throw new Error('rolled back');
    })
    .catch((e: Error) => {
      if (e.message !== 'rolled back') throw e;
    });
  console.log(`after rollback: ${JSON.stringify(await verifyChain(db, heads.map((h) => h.head)))}`);
}
await db.close();
