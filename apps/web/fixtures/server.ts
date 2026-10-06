// Stand-in for the Authority API, Koios, and Sepolia RPC, serving fixtures/recorded.json.
// Same HTTP/SSE contract as apps/api, so every page renders and every e2e test runs without a backend.
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { RunEvent, RunSummary } from '../lib/contract';

const data = JSON.parse(readFileSync(new URL('./recorded.json', import.meta.url), 'utf8'));
const port = Number(process.env.FIXTURE_API_PORT ?? 8787);
const paceMs = Number(process.env.FIXTURE_SSE_PACE_MS ?? 250);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${name} is required`);
  return v;
};

function stream(req: IncomingMessage, res: ServerResponse, runId: string) {
  const events: RunEvent[] | undefined = data.logs[runId];
  if (!events) return json(res, 404, { error: 'run not found' });
  const last = Number(req.headers['last-event-id']);
  const after = Number.isInteger(last) && last > 0 ? last : 0;
  res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 1000\n\n');
  const pending = events.filter((e) => e.seq > after);
  let i = 0;
  const timer = setInterval(() => {
    const e = pending[i++];
    if (e) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    else res.write(': idle\n\n');
  }, paceMs);
  req.on('close', () => clearInterval(timer));
}

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; m: string[] };
type Handler = (c: Ctx) => unknown | Promise<unknown>;
const arg = (c: Ctx, i = 1) => decodeURIComponent(c.m[i] ?? '');
const ok = (c: Ctx, body: unknown) => json(c.res, 200, body);
const getMandate = (c: Ctx) => {
  const view = data.mandates[arg(c)];
  if (!view) throw new HttpError(404, 'mandate not found');
  return view;
};

const routes: Array<[string, RegExp, Handler]> = [
  [
    'GET',
    /^\/v1\/runs$/,
    (c) => {
      const kind = c.url.searchParams.get('kind') ?? 'all';
      const mandate = c.url.searchParams.get('mandate_id');
      const runs = (data.runs as RunSummary[])
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => (kind === 'all' || r.kind === kind) && (!mandate || r.mandate_id === mandate))
        .sort((a, b) => (a.r.started_at < b.r.started_at ? 1 : a.r.started_at > b.r.started_at ? -1 : b.i - a.i))
        .map(({ r }) => r);
      ok(c, { runs });
    },
  ],
  ['POST', /^\/v1\/runs$/, async (c) => (await readBody(c.req), ok(c, { run_id: 'run-stage-0001' }))],
  [
    'GET',
    /^\/v1\/runs\/([^/]+)\/log$/,
    (c) => {
      const run = (data.runs as RunSummary[]).find((r) => r.run_id === arg(c));
      if (!run) throw new HttpError(404, 'run not found');
      ok(c, { run, events: data.logs[run.run_id] });
    },
  ],
  ['GET', /^\/v1\/runs\/([^/]+)\/events$/, (c) => stream(c.req, c.res, arg(c))],
  [
    'POST',
    /^\/v1\/lab\/attacks$/,
    async (c) => {
      const attack = str((await readBody(c.req)).attack, 'attack');
      if (!data.logs[`run-lab-${attack}`]) throw new HttpError(404, 'unknown attack');
      ok(c, { run_id: `run-lab-${attack}` });
    },
  ],
  ['GET', /^\/v1\/mandates\/([^/]+)$/, (c) => ok(c, getMandate(c))],
  [
    'POST',
    /^\/v1\/mandates\/([^/]+)\/(?:revoke|update)$/,
    async (c) => {
      const view = getMandate(c);
      await readBody(c.req);
      ok(c, { unsigned_tx_cbor: '84a400fixture', tx_hash: 'f'.repeat(64), version: view.anchor.version + 1 });
    },
  ],
  [
    'POST',
    /^\/v1\/mandates\/([^/]+)\/submit$/,
    async (c) => {
      getMandate(c);
      ok(c, { tx_hash: str((await readBody(c.req)).tx_hash, 'tx_hash') });
    },
  ],
  [
    'GET',
    /^\/v1\/approvals$/,
    (c) => {
      const status = c.url.searchParams.get('status') ?? 'pending';
      ok(c, { approvals: status === 'pending' ? data.approvals : [] });
    },
  ],
  [
    'POST',
    /^\/v1\/approvals\/([^/]+)\/approve$/,
    (c) => {
      const prepared = data.approve[arg(c)];
      if (!prepared) throw new HttpError(404, 'approval not found');
      ok(c, prepared);
    },
  ],
  [
    'POST',
    /^\/v1\/approvals\/([^/]+)\/decline$/,
    async (c) => {
      // Same rule as the API: a decline carries the CFO's CIP-30 signData result (the API also verifies it).
      const body = await readBody(c.req);
      if (typeof body.signature === 'string' && body.signature && typeof body.key === 'string' && body.key) ok(c, { ok: true });
      else json(c.res, 401, { error: 'CFO signature required' });
    },
  ],
  [
    'POST',
    /^\/v1\/executions$/,
    async (c) => {
      const id = str((await readBody(c.req)).approval_id, 'approval_id');
      ok(c, { run_id: 'run-stage-0001', tx_hash: data.approve[id]?.tx_hash ?? 'e'.repeat(64) });
    },
  ],
  [
    'GET',
    /^\/v1\/receipts$/,
    (c) => {
      const mandate = c.url.searchParams.get('mandate_id');
      const receipts = (data.receipts as Array<{ receipt_id: string }>).filter(
        (r) => !mandate || data.bundles[r.receipt_id]?.receipt.mandate.id === mandate,
      );
      ok(c, { receipts });
    },
  ],
  [
    'GET',
    /^\/v1\/receipts\/([^/]+)$/,
    (c) => {
      const bundle = data.bundles[arg(c)];
      if (!bundle) throw new HttpError(404, 'receipt not found');
      ok(c, bundle);
    },
  ],
  [
    'POST',
    /^\/koios\/tx_info$/,
    async (c) => {
      const hashes = (await readBody(c.req))._tx_hashes;
      if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string')) throw new HttpError(400, '_tx_hashes must be a string array');
      ok(c, hashes.flatMap((h: string) => (data.koios[h] ? [data.koios[h]] : [])));
    },
  ],
  [
    'POST',
    /^\/sepolia$/,
    async (c) => {
      const body = await readBody(c.req);
      const params = Array.isArray(body.params) ? body.params : [];
      ok(c, { jsonrpc: '2.0', id: body.id ?? 1, result: data.sepolia[String(params[0] ?? '')] ?? null });
    },
  ],
];

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (req.method === 'OPTIONS') return json(res, 204, null);
    let pathKnown = false;
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (!m) continue;
      pathKnown = true;
      if (method === req.method) return void (await handler({ req, res, url, m }));
    }
    if (pathKnown) return json(res, 405, { error: `${req.method} not allowed on ${url.pathname}` });
    return json(res, 404, { error: `no fixture for ${req.method} ${url.pathname}` });
  } catch (e) {
    if (res.headersSent) return void res.end();
    const status = e instanceof HttpError ? e.status : 500;
    return json(res, status, { error: e instanceof Error ? e.message : 'internal error' });
  }
}).listen(port, () => console.log(`fixture API on http://localhost:${port}`));
