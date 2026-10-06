// Stand-in for the Authority API, Koios, and Sepolia RPC, serving fixtures/recorded.json.
// Same HTTP/SSE contract as apps/api, so every page renders and every e2e test runs without a backend.
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { RunEvent } from '../lib/contract';

const data = JSON.parse(readFileSync(new URL('./recorded.json', import.meta.url), 'utf8'));
const port = Number(process.env.FIXTURE_API_PORT ?? 8787);
const paceMs = Number(process.env.FIXTURE_SSE_PACE_MS ?? 250);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : null;
}

function stream(req: IncomingMessage, res: ServerResponse, runId: string) {
  const events: RunEvent[] = data.logs[runId] ?? [];
  const after = Number(req.headers['last-event-id'] ?? 0);
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

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const p = url.pathname;
  if (req.method === 'OPTIONS') return json(res, 204, null);
  let m: RegExpExecArray | null;
  if (req.method === 'GET' && p === '/v1/runs') {
    const kind = url.searchParams.get('kind') ?? 'all';
    return json(res, 200, { runs: data.runs.filter((r: { kind: string }) => kind === 'all' || r.kind === kind) });
  }
  if (req.method === 'POST' && p === '/v1/runs') return json(res, 200, { run_id: 'run-stage-0001' });
  if ((m = /^\/v1\/runs\/([^/]+)\/log$/.exec(p))) {
    const run = data.runs.find((r: { run_id: string }) => r.run_id === m?.[1]);
    return run ? json(res, 200, { run, events: data.logs[run.run_id] }) : json(res, 404, { error: 'run not found' });
  }
  if ((m = /^\/v1\/runs\/([^/]+)\/events$/.exec(p))) return stream(req, res, m[1] ?? '');
  if (req.method === 'POST' && p === '/v1/lab/attacks') {
    const { attack } = (await readBody(req)) as { attack: string };
    return data.logs[`run-lab-${attack}`] ? json(res, 200, { run_id: `run-lab-${attack}` }) : json(res, 404, { error: 'unknown attack' });
  }
  if ((m = /^\/v1\/mandates\/([^/]+)$/.exec(p))) {
    const view = data.mandates[decodeURIComponent(m[1] ?? '')];
    return view ? json(res, 200, view) : json(res, 404, { error: 'mandate not found' });
  }
  if ((m = /^\/v1\/mandates\/([^/]+)\/(revoke|update)$/.exec(p))) {
    const view = data.mandates[decodeURIComponent(m[1] ?? '')];
    return json(res, 200, { unsigned_tx_cbor: '84a400fixture', tx_hash: 'f'.repeat(64), version: view.anchor.version + 1 });
  }
  if ((m = /^\/v1\/mandates\/([^/]+)\/submit$/.exec(p))) {
    const body = (await readBody(req)) as { tx_hash: string };
    return json(res, 200, { tx_hash: body.tx_hash });
  }
  if (p === '/v1/approvals') return json(res, 200, { approvals: data.approvals });
  if ((m = /^\/v1\/approvals\/([^/]+)\/approve$/.exec(p))) {
    const prepared = data.approve[decodeURIComponent(m[1] ?? '')];
    return prepared ? json(res, 200, prepared) : json(res, 404, { error: 'approval not found' });
  }
  if (/^\/v1\/approvals\/[^/]+\/decline$/.test(p)) {
    // Same rule as the API: a decline carries the CFO's CIP-30 signData result (the API also verifies it).
    const body = (await readBody(req)) as { signature?: string; key?: string } | null;
    return body?.signature && body.key ? json(res, 200, { ok: true }) : json(res, 401, { error: 'CFO signature required' });
  }
  if (req.method === 'POST' && p === '/v1/executions') {
    const body = (await readBody(req)) as { approval_id: string };
    return json(res, 200, { run_id: 'run-stage-0001', tx_hash: data.approve[body.approval_id]?.tx_hash ?? 'e'.repeat(64) });
  }
  if (p === '/v1/receipts') return json(res, 200, { receipts: data.receipts });
  if ((m = /^\/v1\/receipts\/([^/]+)$/.exec(p))) {
    const bundle = data.bundles[decodeURIComponent(m[1] ?? '')];
    return bundle ? json(res, 200, bundle) : json(res, 404, { error: 'receipt not found' });
  }
  if (req.method === 'POST' && p === '/koios/tx_info') {
    const body = (await readBody(req)) as { _tx_hashes: string[] };
    return json(res, 200, body._tx_hashes.flatMap((h) => (data.koios[h] ? [data.koios[h]] : [])));
  }
  if (req.method === 'POST' && p === '/sepolia') {
    const body = (await readBody(req)) as { id: number; params: string[] };
    return json(res, 200, { jsonrpc: '2.0', id: body.id, result: data.sepolia[body.params[0] ?? ''] ?? null });
  }
  return json(res, 404, { error: `no fixture for ${req.method} ${p}` });
}).listen(port, () => console.log(`fixture API on http://localhost:${port}`));
