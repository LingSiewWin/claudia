import { sha256Hex } from '@authority/core';
import type { Db } from '@authority/db';
import { HttpError, type Reply } from './http';

/** An in-progress key older than this is treated as abandoned (crash) and taken over. */
export const IDEMPOTENCY_STALE_MS = 300_000;

const transient = (status: number) => status >= 500 || status === 429 || status === 408;

/** Identifies one claim of (caller, key). A stale takeover advances created_at, so a loser must not match the successor. */
const attemptStamp = `to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;

/**
 * Same (caller, key) and same body: the stored reply, without running again. Same key, different body: 422.
 * Still running: 429 with Retry-After (the caller retries). Transient failures are not stored, so a retry runs again.
 */
export async function idempotent(db: Db, caller: string, key: string, rawBody: string, run: () => Promise<Reply>): Promise<Reply> {
  const requestHash = sha256Hex(rawBody);
  const claimed = await db.query<{ created_at: string }>(
    `insert into idempotency (caller, key, request_hash) values ($1, $2, $3) on conflict do nothing returning ${attemptStamp} as created_at`,
    [caller, key, requestHash],
  );
  let createdAt: string;
  if (claimed.length === 0) {
    const [row] = await db.query<{ request_hash: string; status: number | null; response: string | null; age_ms: string }>(
      `select request_hash, status, response, (extract(epoch from now() - created_at) * 1000)::bigint::text as age_ms
       from idempotency where caller = $1 and key = $2`,
      [caller, key],
    );
    if (!row) throw new HttpError(429, 'idempotency key changed state, retry', { 'retry-after': '1' });
    if (row.request_hash !== requestHash) throw new HttpError(422, 'Idempotency-Key was already used with a different request');
    if (row.status !== null && row.response !== null) return { status: row.status, body: JSON.parse(row.response) };
    if (Number(row.age_ms) < IDEMPOTENCY_STALE_MS) {
      throw new HttpError(429, 'a request with this Idempotency-Key is still running', { 'retry-after': '5' });
    }
    const [taken] = await db.query<{ created_at: string }>(
      `update idempotency set created_at = now() where caller = $1 and key = $2 returning ${attemptStamp} as created_at`,
      [caller, key],
    );
    if (!taken) throw new HttpError(429, 'idempotency key changed state, retry', { 'retry-after': '1' });
    createdAt = taken.created_at;
  } else {
    createdAt = claimed[0]!.created_at;
  }
  const dropThisAttempt = () =>
    db.query(`delete from idempotency where caller = $1 and key = $2 and ${attemptStamp} = $3`, [caller, key, createdAt]);
  let reply: Reply;
  try {
    reply = await run();
  } catch (error) {
    if (!(error instanceof HttpError) || transient(error.status)) {
      await dropThisAttempt();
      throw error;
    }
    reply = { status: error.status, body: { error: error.message } };
  }
  if (transient(reply.status)) {
    await dropThisAttempt();
  } else {
    await db.query('update idempotency set status = $3, response = $4 where caller = $1 and key = $2', [
      caller,
      key,
      reply.status,
      JSON.stringify(reply.body),
    ]);
  }
  return reply;
}
