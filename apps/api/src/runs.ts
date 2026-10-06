import { randomUUID } from 'node:crypto';
import type { Db, StoredEvent } from '@authority/db';
import { readRun } from '@authority/db';
import { HttpError } from './http';
import type { EventLog } from './log';
import { limitsOf, type MandateRow } from './mandates';

export type RunKind = 'stage' | 'lab' | 'masumi';
export interface RunRow {
  run_id: string;
  kind: RunKind;
  mandate_id: string;
  attack: string | null;
  goal: string;
  status: 'pending' | 'active' | 'finished';
}
export interface RunSummary {
  run_id: string;
  kind: RunKind;
  mandate_id: string;
  started_at: string;
  event_count: number;
  attack: string | null;
}

/** A run that has not finished within this window no longer blocks a new one. */
export const RUN_WINDOW_MS = 15 * 60_000;

export async function createRun(
  db: Db,
  log: EventLog,
  input: { kind: RunKind; row: MandateRow; goal: string; attack?: string; status: RunRow['status']; vault: { balance: string; spent_today: string } },
): Promise<string> {
  const runId = randomUUID();
  const m = input.row.mandate;
  await db.query('insert into runs (run_id, kind, mandate_id, attack, goal, status) values ($1, $2, $3, $4, $5, $6)', [
    runId,
    input.kind,
    m.id,
    input.attack ?? null,
    input.goal,
    input.status,
  ]);
  await log.emit({
    run_id: runId,
    action_id: null,
    type: 'RunStarted',
    payload: {
      kind: input.kind,
      mandate_id: m.id,
      mandate_version: m.version,
      principal: m.principal.name,
      delegate: input.row.delegateName,
      agent_public_key: m.delegate.public_key.slice('ed25519:'.length),
      engine_public_key: m.authority_engine.public_key.slice('ed25519:'.length),
      limits: limitsOf(m),
      vault: input.vault,
      goal: input.goal,
    },
  });
  return runId;
}

/** One live run per kind: a second request inside the window is told to retry later. */
export async function assertNoLiveRun(db: Db, kind: RunKind): Promise<void> {
  const [live] = await db.query<{ run_id: string }>(
    `select run_id::text as run_id from runs where kind = $1 and status <> 'finished'
     and started_at > now() - ($2::int * interval '1 millisecond') limit 1`,
    [kind, RUN_WINDOW_MS],
  );
  if (live) throw new HttpError(429, `a ${kind} run is already in progress (${live.run_id})`, { 'retry-after': '30' });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_COLUMNS = `run_id::text as run_id, kind, mandate_id, attack, goal, status`;

export async function getRun(db: Db, runId: string): Promise<RunRow | null> {
  if (!UUID.test(runId)) return null;
  const [row] = await db.query<RunRow>(`select ${RUN_COLUMNS} from runs where run_id = $1`, [runId]);
  return row ?? null;
}

/** The agent attaches its checks to a run it claimed, under that run's mandate. */
export async function attachRun(db: Db, runId: string, mandateId: string): Promise<RunRow> {
  const run = await getRun(db, runId);
  if (!run) throw new HttpError(404, 'unknown run');
  if (run.status !== 'active') throw new HttpError(409, `run is ${run.status}, not active`);
  if (run.mandate_id !== mandateId) throw new HttpError(409, `run belongs to ${run.mandate_id}`);
  return run;
}

export async function claimRun(db: Db): Promise<RunRow | null> {
  const [row] = await db.query<RunRow>(
    `update runs set status = 'active' where run_id = (
       select run_id from runs where status = 'pending' and kind in ('stage', 'lab') order by started_at limit 1
     ) and status = 'pending' returning ${RUN_COLUMNS}`,
  );
  return row ?? null;
}

export async function finishRun(db: Db, runId: string): Promise<RunRow> {
  const [row] = await db.query<RunRow>(
    `update runs set status = 'finished', finished_at = now() where run_id = $1 and status = 'active' returning ${RUN_COLUMNS}`,
    [runId],
  );
  if (!row) throw new HttpError(409, 'run is not active');
  return row;
}

/** Emits RunCompleted once the run is finished and no release is still in flight. */
export async function completeRun(db: Db, log: EventLog, runId: string): Promise<void> {
  const [run] = await db.query<{ status: string; kind: string }>(`select status, kind from runs where run_id = $1`, [runId]);
  if (run?.status !== 'finished' || run.kind === 'masumi') return;
  const [pending] = await db.query<{ n: number }>(
    `select count(*)::int as n from authorizations where run_id = $1 and status in ('queued', 'submitted', 'awaiting_cfo')`,
    [runId],
  );
  if ((pending?.n ?? 0) > 0) return;
  const [done] = await db.query(`select 1 from events where run_id = $1 and type = 'RunCompleted' limit 1`, [runId]);
  if (done) return;
  await log.emit({ run_id: runId, action_id: null, type: 'RunCompleted', payload: { status: 'finished' } });
}

const SUMMARY = `select r.run_id::text as run_id, r.kind, r.mandate_id, r.attack,
  to_char(r.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at,
  (select count(*)::int from events e where e.run_id = r.run_id) as event_count from runs r`;

export async function listRuns(db: Db, kind: RunKind | 'all'): Promise<RunSummary[]> {
  return db.query<RunSummary>(`${SUMMARY} where ($1 = 'all' or r.kind = $1) order by r.started_at desc limit 100`, [kind]);
}

export async function runLog(db: Db, runId: string): Promise<{ run: RunSummary; events: StoredEvent[] }> {
  const [run] = UUID.test(runId) ? await db.query<RunSummary>(`${SUMMARY} where r.run_id = $1`, [runId]) : [];
  if (!run) throw new HttpError(404, 'unknown run');
  return { run, events: await readRun(db, runId) };
}
