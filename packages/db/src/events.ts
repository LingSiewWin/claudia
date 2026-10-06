import { canonicalJson, concatBytes, hexToBytes, sha256Hex, utf8ToBytes } from '@authority/core';
import type { Sql } from './db';

export const GENESIS_HASH = '00'.repeat(32);
// Advisory lock id that serializes appends to the single global chain.
const CHAIN_LOCK = 7001;

export interface EventBody {
  seq: number;
  run_id: string;
  action_id: string | null;
  type: string;
  payload: unknown;
  created_at: string;
}
export interface StoredEvent extends EventBody {
  hash: string;
  prev_hash: string;
}
export interface AppendInput {
  run_id: string;
  action_id: string | null;
  type: string;
  payload: unknown;
}

// hash = sha256(prev_hash || RFC 8785({ seq, run_id, action_id, type, payload, created_at }))
export function eventHash(prevHash: string, body: EventBody): string {
  return sha256Hex(concatBytes(hexToBytes(prevHash), utf8ToBytes(canonicalJson(body))));
}

interface Row {
  seq: string;
  run_id: string;
  action_id: string | null;
  type: string;
  payload: string;
  prev_hash: string;
  hash: string;
  created_at: string;
}
const COLUMNS = `seq::text as seq, run_id::text as run_id, action_id, type, payload,
  encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at`;

function toEvent(r: Row): StoredEvent {
  return {
    seq: Number(r.seq),
    run_id: r.run_id,
    action_id: r.action_id,
    type: r.type,
    payload: JSON.parse(r.payload),
    created_at: r.created_at,
    hash: r.hash,
    prev_hash: r.prev_hash,
  };
}

/** Appends one event. Call inside a transaction: the chain lock is held until commit. */
export async function appendEvent(q: Sql, input: AppendInput, nowMs: number): Promise<StoredEvent> {
  if (!Number.isSafeInteger(nowMs)) throw new TypeError('appendEvent: nowMs must be a safe integer');
  await q.query('select pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
  const [head] = await q.query<{ seq: string; hash: string }>(
    `select seq::text as seq, encode(hash, 'hex') as hash from events order by events.seq desc limit 1`,
  );
  const payloadText = canonicalJson(input.payload);
  const body: EventBody = {
    seq: head ? Number(head.seq) + 1 : 1,
    run_id: input.run_id,
    action_id: input.action_id,
    type: input.type,
    payload: JSON.parse(payloadText),
    created_at: new Date(nowMs).toISOString(),
  };
  const prev = head?.hash ?? GENESIS_HASH;
  const hash = eventHash(prev, body);
  await q.query(
    `insert into events (seq, run_id, action_id, type, payload, prev_hash, hash, created_at)
     values ($1, $2, $3, $4, $5, decode($6, 'hex'), decode($7, 'hex'), $8)`,
    [body.seq, body.run_id, body.action_id, body.type, payloadText, prev, hash, body.created_at],
  );
  return { ...body, hash, prev_hash: prev };
}

/** The latest event's seq and hash ({ seq: 0, hash: GENESIS_HASH } for an empty log). */
export interface ChainHead {
  seq: number;
  hash: string;
}

export async function chainHead(q: Sql): Promise<ChainHead> {
  const [head] = await q.query<{ seq: string; hash: string }>(
    `select seq::text as seq, encode(hash, 'hex') as hash from events order by events.seq desc limit 1`,
  );
  return head ? { seq: Number(head.seq), hash: head.hash } : { seq: 0, hash: GENESIS_HASH };
}

export async function readRun(q: Sql, runId: string, afterSeq = 0): Promise<StoredEvent[]> {
  const rows = await q.query<Row>(`select ${COLUMNS} from events where run_id = $1 and seq > $2 order by events.seq`, [runId, afterSeq]);
  return rows.map(toEvent);
}

export async function eventByHash(q: Sql, hash: string): Promise<StoredEvent | null> {
  const [row] = await q.query<Row>(`select ${COLUMNS} from events where hash = decode($1, 'hex')`, [hash]);
  return row ? toEvent(row) : null;
}

export type ChainCheck = { ok: true; count: number; head: string } | { ok: false; seq: number; problem: string };

/**
 * Recomputes the whole chain from genesis. `anchored` are heads committed on-chain (settlement metadata log_head
 * { seq, hash }): recomputing the stored chain up to each seq must give exactly that hash, so a rewrite that
 * recomputes every later hash is caught as well.
 * Loads every row; page through by seq if the log outgrows memory.
 */
export async function verifyChain(q: Sql, anchored: readonly ChainHead[] = []): Promise<ChainCheck> {
  const rows = await q.query<Row>(`select ${COLUMNS} from events order by events.seq`);
  const recomputed = new Map<number, string>();
  let prev = GENESIS_HASH;
  for (const [i, row] of rows.entries()) {
    const seq = Number(row.seq);
    if (seq !== i + 1) return { ok: false, seq, problem: `expected seq ${i + 1}` };
    if (row.prev_hash !== prev) return { ok: false, seq, problem: 'prev_hash does not link to the previous event' };
    let event: StoredEvent;
    try {
      event = toEvent(row);
    } catch {
      return { ok: false, seq, problem: 'payload is not JSON' };
    }
    const { hash, prev_hash: _prev, ...body } = event;
    if (eventHash(prev, body) !== hash) return { ok: false, seq, problem: 'hash does not match the event contents' };
    recomputed.set(seq, hash);
    prev = hash;
  }
  const missing = [...anchored].sort((a, b) => a.seq - b.seq).find((a) => recomputed.get(a.seq) !== a.hash.toLowerCase());
  if (missing !== undefined) return { ok: false, seq: missing.seq, problem: `anchored head ${missing.hash} is not the chain at seq ${missing.seq}` };
  return { ok: true, count: rows.length, head: prev };
}
