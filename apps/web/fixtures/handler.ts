// Stand-in for the Authority API, Koios, and Sepolia RPC, serving ./recorded.json.
// Same HTTP/SSE contract as apps/api. Pure: `dispatch` maps a request to a reply, so the node server
// (fixtures/server.ts) and the Next route (app/api/fixture) share one table of routes.
import type { RunEvent, RunSummary } from '../lib/contract';
import recorded from './recorded.json';

const data = recorded as any;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Reply = { status: number; body: unknown } | { sse: RunEvent[] };

async function readBody(raw: string): Promise<Record<string, unknown>> {
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

/** Events after Last-Event-ID, for the SSE stream. */
function stream(runId: string, lastEventId: string | undefined): Reply {
  const events: RunEvent[] | undefined = own(data.logs, runId);
  if (!events) return { status: 404, body: { error: 'run not found' } };
  const last = Number(lastEventId);
  const after = Number.isInteger(last) && last > 0 ? last : 0;
  return { sse: events.filter((e) => e.seq > after) };
}

type Ctx = { url: URL; m: string[]; body: () => Promise<Record<string, unknown>>; lastEventId: string | undefined };
type Handler = (c: Ctx) => Reply | Promise<Reply>;
const arg = (c: Ctx, i = 1) => {
  try {
    return decodeURIComponent(c.m[i] ?? '');
  } catch {
    throw new HttpError(400, 'malformed percent-escape in path');
  }
};
// Own-property lookup: a path segment or body value such as "__proto__" must never resolve to Object.prototype.
const own = (table: Record<string, any>, key: string): any => (Object.hasOwn(table, key) ? table[key] : undefined);
const ok = (body: unknown): Reply => ({ status: 200, body });
const getMandate = (c: Ctx) => {
  const view = own(data.mandates, arg(c));
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
      return ok({ runs });
    },
  ],
  ['POST', /^\/v1\/runs$/, async (c) => (await c.body(), ok({ run_id: 'run-stage-0001' }))],
  [
    'GET',
    /^\/v1\/runs\/([^/]+)\/log$/,
    (c) => {
      const run = (data.runs as RunSummary[]).find((r) => r.run_id === arg(c));
      if (!run) throw new HttpError(404, 'run not found');
      return ok({ run, events: data.logs[run.run_id], anchor: own(data.anchors, run.run_id) ?? null });
    },
  ],
  ['GET', /^\/v1\/runs\/([^/]+)\/events$/, (c) => stream(arg(c), c.lastEventId)],
  [
    'POST',
    /^\/v1\/lab\/attacks$/,
    async (c) => {
      const attack = str((await c.body()).attack, 'attack');
      if (!own(data.logs, `run-lab-${attack}`)) throw new HttpError(404, 'unknown attack');
      return ok({ run_id: `run-lab-${attack}` });
    },
  ],
  ['GET', /^\/v1\/mandates\/([^/]+)$/, (c) => ok(getMandate(c))],
  [
    'POST',
    /^\/v1\/mandates\/([^/]+)\/(?:revoke|update)$/,
    async (c) => {
      const view = getMandate(c);
      await c.body();
      return ok({ unsigned_tx_cbor: '84a400fixture', tx_hash: 'f'.repeat(64), version: view.anchor.version + 1 });
    },
  ],
  [
    'POST',
    /^\/v1\/mandates\/([^/]+)\/submit$/,
    async (c) => {
      getMandate(c);
      return ok({ tx_hash: str((await c.body()).tx_hash, 'tx_hash') });
    },
  ],
  [
    'GET',
    /^\/v1\/approvals$/,
    (c) => {
      const status = c.url.searchParams.get('status') ?? 'pending';
      return ok({ approvals: status === 'pending' ? data.approvals : [] });
    },
  ],
  [
    'POST',
    /^\/v1\/approvals\/([^/]+)\/approve$/,
    (c) => {
      const prepared = own(data.approve, arg(c));
      if (!prepared) throw new HttpError(404, 'approval not found');
      return ok(prepared);
    },
  ],
  [
    'POST',
    /^\/v1\/approvals\/([^/]+)\/decline$/,
    async (c) => {
      // Same rule as the API: a decline carries the CFO's CIP-30 signData result and a reason (the API also verifies it),
      // and answers with the bond spend for the approver wallet to sign.
      const body = await c.body();
      if (!(typeof body.signature === 'string' && body.signature && typeof body.key === 'string' && body.key)) {
        return { status: 401, body: { error: 'CFO signature required' } };
      }
      if (body.reason !== 'legitimate' && body.reason !== 'frivolous') throw new HttpError(400, 'reason must be legitimate or frivolous');
      return ok({ unsigned_tx_cbor: '84a400bondfixture', tx_hash: 'd'.repeat(64) });
    },
  ],
  [
    'POST',
    /^\/v1\/approvals\/([^/]+)\/bond-submit$/,
    async (c) => {
      const body = await c.body();
      str(body.cfo_witness_cbor, 'cfo_witness_cbor');
      return ok({ tx_hash: str(body.tx_hash, 'tx_hash') });
    },
  ],
  [
    'GET',
    /^\/v1\/authority\/([^/]+)$/,
    (c) => {
      const info = own(data.authority, `${c.url.searchParams.get('mandate_id') ?? ''}/${arg(c)}`);
      if (!info) throw new HttpError(404, 'authority not found');
      return ok(info);
    },
  ],
  [
    'GET',
    /^\/v1\/metrics$/,
    (c) => {
      const metrics = own(data.metrics, c.url.searchParams.get('mandate_id') ?? '');
      if (!metrics) throw new HttpError(404, 'mandate not found');
      return ok(metrics);
    },
  ],
  [
    'POST',
    /^\/v1\/executions$/,
    async (c) => {
      const id = str((await c.body()).approval_id, 'approval_id');
      return ok({ run_id: 'run-stage-0001', tx_hash: own(data.approve, id)?.tx_hash ?? 'e'.repeat(64) });
    },
  ],
  [
    'GET',
    /^\/v1\/receipts$/,
    (c) => {
      const mandate = c.url.searchParams.get('mandate_id');
      const receipts = (data.receipts as Array<{ receipt_id: string }>).filter(
        (r) => !mandate || own(data.bundles, r.receipt_id)?.receipt.mandate.id === mandate,
      );
      return ok({ receipts });
    },
  ],
  [
    'GET',
    /^\/v1\/receipts\/([^/]+)$/,
    (c) => {
      const bundle = own(data.bundles, arg(c));
      if (!bundle) throw new HttpError(404, 'receipt not found');
      return ok(bundle);
    },
  ],
  [
    'POST',
    /^\/koios\/tx_info$/,
    async (c) => {
      const hashes = (await c.body())._tx_hashes;
      if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string')) throw new HttpError(400, '_tx_hashes must be a string array');
      return ok(hashes.flatMap((h: string) => (own(data.koios, h) ? [own(data.koios, h)] : [])));
    },
  ],
  [
    'POST',
    /^\/sepolia$/,
    async (c) => {
      const body = await c.body();
      const params = Array.isArray(body.params) ? body.params : [];
      return ok({ jsonrpc: '2.0', id: body.id ?? 1, result: own(data.sepolia, String(params[0] ?? '')) ?? null });
    },
  ],
];


/** One request in, one reply out. Unknown path -> 404, known path with another method -> 405. */
export async function dispatch(method: string, url: URL, rawBody: () => Promise<string>, lastEventId?: string): Promise<Reply> {
  try {
    if (method === 'OPTIONS') return { status: 204, body: null };
    let pathKnown = false;
    for (const [m, re, handler] of routes) {
      const match = re.exec(url.pathname);
      if (!match) continue;
      pathKnown = true;
      if (m === method) return await handler({ url, m: match, body: async () => readBody(await rawBody()), lastEventId });
    }
    if (pathKnown) return { status: 405, body: { error: `${method} not allowed on ${url.pathname}` } };
    return { status: 404, body: { error: `no fixture for ${method} ${url.pathname}` } };
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return { status, body: { error: e instanceof Error ? e.message : 'internal error' } };
  }
}
