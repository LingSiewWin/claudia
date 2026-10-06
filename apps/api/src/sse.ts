import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Db, readRun, type StoredEvent } from '@authority/db';
import type { EventLog } from './log';

export const HEARTBEAT_MS = 15_000;

/**
 * GET /v1/runs/{id}/events. Stored events first (after Last-Event-ID), then live ones, each exactly once:
 * `id: <seq>` + `data: <event JSON>`, no `event:` field. A comment line every 15 s keeps proxies from
 * closing an idle stream; EventSource reconnects with Last-Event-ID when the platform's stream cap is hit.
 */
export async function streamRun(db: Db, log: EventLog, req: IncomingMessage, res: ServerResponse, runId: string, cors: Record<string, string>) {
  const header = req.headers['last-event-id'];
  const after = typeof header === 'string' && /^\d{1,15}$/.test(header) ? Number(header) : 0;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...cors,
  });
  res.write('retry: 3000\n\n');
  let sent = after;
  let replaying = true;
  const queued: StoredEvent[] = [];
  const write = (e: StoredEvent) => {
    if (e.seq <= sent) return;
    sent = e.seq;
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const off = log.subscribe(runId, (e) => (replaying ? queued.push(e) : write(e)));
  const ping = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    off();
    clearInterval(ping);
  });
  for (const e of await readRun(db, runId, after)) write(e);
  replaying = false;
  for (const e of queued) write(e);
}
