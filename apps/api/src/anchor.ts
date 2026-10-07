import type { Db } from '@authority/db';

export interface RunAnchor {
  tx_hash: string;
  seq: number;
  hash: string;
}

/**
 * The first confirmed settlement whose metadata log_head covers this run's last event. A run that ended without
 * its own settlement (all denials) is anchored by the next settlement anyone makes; until then: null
 * ("integrity checked, not anchored").
 * ponytail: scans every TransactionBuilt event; index log_head.seq if the log grows large.
 */
export async function anchorFor(db: Db, runId: string): Promise<RunAnchor | null> {
  const [last] = await db.query<{ seq: string | null }>('select max(seq)::text as seq from events where run_id = $1', [runId]);
  if (!last?.seq) return null;
  const settled = new Set(
    (await db.query<{ tx_hash: string }>(`select tx_hash from authorizations where status = 'settled' and tx_hash is not null`)).map((r) => r.tx_hash),
  );
  const built = await db.query<{ payload: string }>(`select payload from events where type = 'TransactionBuilt' order by events.seq`);
  for (const b of built) {
    const p = JSON.parse(b.payload) as { tx_hash: string; log_head?: { seq: number; hash: string } };
    if (p.log_head && p.log_head.seq >= Number(last.seq) && settled.has(p.tx_hash)) {
      return { tx_hash: p.tx_hash, seq: p.log_head.seq, hash: p.log_head.hash };
    }
  }
  return null;
}
