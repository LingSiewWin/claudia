import { setTimeout as sleep } from 'node:timers/promises';
import type { Trigger } from '@authority/chainlink';
import type { Db } from '@authority/db';
import { HttpError, parseJson, type Reply } from './http';

export const RELAY_TIMEOUT_MS = 300_000;

/**
 * CRE trigger through an operator machine that holds the CRE CLI login. The API writes the payload (its own
 * trigger_id included); the relay runs `cre workflow simulate --broadcast` and posts the CLI output back. The API
 * then reads the report from Sepolia itself and checks hash, action and trigger id, so a lying relay can only
 * withhold or delay a report (VERIFICATION_UNAVAILABLE), never forge one.
 */
export function relayTrigger(db: Db, opts: { timeoutMs?: number; pollMs?: number } = {}): Trigger {
  const timeoutMs = opts.timeoutMs ?? RELAY_TIMEOUT_MS;
  return async (payload) => {
    await db.query(`insert into cre_jobs (trigger_id, payload, status) values ($1, $2, 'queued')`, [payload.trigger_id, JSON.stringify(payload)]);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [job] = await db.query<{ status: string; output: string | null }>('select status, output from cre_jobs where trigger_id = $1', [
        payload.trigger_id,
      ]);
      if (job?.status === 'done') return job.output ?? '';
      await sleep(opts.pollMs ?? 1_000);
    }
    await db.query(`update cre_jobs set status = 'expired' where trigger_id = $1 and status <> 'done'`, [payload.trigger_id]);
    throw new Error('the CRE relay did not answer in time');
  };
}

export async function claimJob(db: Db): Promise<Reply> {
  const [job] = await db.query<{ trigger_id: string; payload: string }>(
    `update cre_jobs set status = 'claimed' where trigger_id = (
       select trigger_id from cre_jobs where status = 'queued' order by created_at limit 1
     ) and status = 'queued' returning trigger_id, payload`,
  );
  return job ? { status: 200, body: { trigger_id: job.trigger_id, payload: JSON.parse(job.payload) } } : { status: 204, body: null };
}

export async function completeJob(db: Db, triggerId: string, rawBody: string): Promise<Reply> {
  const body = parseJson(rawBody) as { output?: unknown };
  if (typeof body?.output !== 'string') throw new HttpError(400, 'body must be { output: string }');
  const done = await db.query(`update cre_jobs set status = 'done', output = $2 where trigger_id = $1 and status = 'claimed' returning trigger_id`, [
    triggerId,
    body.output,
  ]);
  if (done.length === 0) throw new HttpError(409, 'no claimed job with this trigger id');
  return { status: 200, body: { ok: true } };
}
