import type { IncomingMessage, ServerResponse } from 'node:http';
import { DAY_MS } from '@authority/core';
import { type Caller, type Engine, handleCheck } from './check';
import { bearer, HttpError, idempotencyKey, parseJson, readBody, type Reply, send } from './http';
import { currentMandate, limitsOf, mandateOfKind, readChain, vaultSummary } from './mandates';
import type { LabDeps } from './ports';
import { receiptBundle, settlementReceipts } from './receipts';
import { assertNoLiveRun, claimRun, completeRun, createRun, finishRun, listRuns, type RunKind, runLog } from './runs';
import { streamRun } from './sse';

export interface AppDeps {
  eng: Engine;
  lab: LabDeps;
  keys: { agent: string | undefined; masumi: string | undefined; relay: string | undefined };
  /** Browser origins allowed to POST (the web app). GETs and SSE are public. */
  webOrigins: string[];
}

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; url: URL; cors: Record<string, string> }) => Promise<Reply | null>;
interface Route {
  method: 'GET' | 'POST';
  path: RegExp;
  handler: Handler;
}

const ID = '([A-Za-z0-9._-]{1,64})';

async function mandateView(eng: Engine, id: string): Promise<Reply> {
  const row = await currentMandate(eng.db, id);
  if (!row) throw new HttpError(404, `unknown mandate ${id}`);
  const { vault, anchor } = await readChain(eng.cardano, row, eng.now());
  const today = Math.floor(eng.now() / DAY_MS);
  return {
    status: 200,
    body: {
      mandate: row.mandate,
      mandate_hash: row.hash,
      limits: limitsOf(row.mandate),
      anchor: { mandate_ref: row.binding.mandateRef, version: anchor.version, status: anchor.status, tx_hash: anchor.tx_hash },
      vault: {
        vault_hash: row.binding.vaultHash,
        balance: vault.balance.toString(),
        // What the engine and the vault (R12) count today: yesterday's spend no longer applies.
        spent_today: (vault.day_index < today ? 0n : vault.spent_today).toString(),
        day_index: vault.day_index,
        last_nonce: vault.last_nonce.toString(),
        tx_hash: vault.tx_hash,
      },
    },
  };
}

export function createApp(deps: AppDeps) {
  const { eng } = deps;
  const ok = (body: unknown): Reply => ({ status: 200, body });
  const agentOnly = (req: IncomingMessage) => bearer<'agent'>(req, { agent: deps.keys.agent });

  const routes: Route[] = [
    { method: 'GET', path: /^\/health$/, handler: async () => ok({ ok: true }) },
    {
      method: 'POST',
      path: /^\/v1\/authority\/check$/,
      handler: async ({ req }) => {
        const caller = bearer<Caller>(req, { agent: deps.keys.agent, masumi: deps.keys.masumi });
        const key = idempotencyKey(req);
        return handleCheck(eng, caller, key, await readBody(req));
      },
    },
    {
      method: 'GET',
      path: /^\/v1\/runs$/,
      handler: async ({ url }) => {
        const kind = url.searchParams.get('kind') ?? 'all';
        if (!['stage', 'lab', 'masumi', 'all'].includes(kind)) throw new HttpError(400, 'kind must be stage, lab, masumi or all');
        return ok({ runs: await listRuns(eng.db, kind as RunKind | 'all') });
      },
    },
    {
      method: 'POST',
      path: /^\/v1\/runs$/,
      handler: async ({ req }) => {
        const body = parseJson(await readBody(req)) as { mandate_id?: unknown };
        const row = await mandateOfKind(eng.db, 'stage');
        if (!row || body?.mandate_id !== row.mandate.id) throw new HttpError(400, 'runs start under the stage mandate');
        await assertNoLiveRun(eng.db, 'stage');
        const { vault } = await readChain(eng.cardano, row, eng.now());
        const runId = await createRun(eng.db, eng.log, {
          kind: 'stage',
          row,
          goal: "Process today's open vendor invoices",
          status: 'pending',
          vault: vaultSummary(vault, eng.now()),
        });
        return ok({ run_id: runId });
      },
    },
    {
      method: 'GET',
      path: /^\/v1\/runs\/([0-9a-f-]{36})\/log$/,
      handler: async ({ params }) => ok({ ...(await runLog(eng.db, params[0]!)), anchor: null }),
    },
    {
      method: 'GET',
      path: /^\/v1\/runs\/([0-9a-f-]{36})\/events$/,
      handler: async ({ req, res, params, cors }) => {
        await runLog(eng.db, params[0]!); // 404 for an unknown run, before the stream starts
        await streamRun(eng.db, eng.log, req, res, params[0]!, cors);
        return null;
      },
    },
    {
      method: 'POST',
      path: /^\/v1\/agent\/runs\/claim$/,
      handler: async ({ req }) => {
        agentOnly(req);
        const run = await claimRun(eng.db);
        return run ? ok({ run_id: run.run_id, kind: run.kind, mandate_id: run.mandate_id, goal: run.goal, attack: run.attack }) : { status: 204, body: null };
      },
    },
    {
      method: 'POST',
      path: /^\/v1\/agent\/runs\/([0-9a-f-]{36})\/finish$/,
      handler: async ({ req, params }) => {
        agentOnly(req);
        const run = await finishRun(eng.db, params[0]!);
        if (run.kind === 'lab' && run.attack?.startsWith('prompt_injection')) {
          const [done] = await eng.db.query(`select 1 from events where run_id = $1 and type = 'AttackResult' limit 1`, [run.run_id]);
          // The model was not fooled (or proposed the vendor's real address): recorded as such, never faked.
          if (!done) {
            await eng.log.emit({
              run_id: run.run_id,
              action_id: null,
              type: 'AttackResult',
              payload: { attack: run.attack, stopped_by: 'agent', code: 'AGENT_REJECTED_PHISHING', funds_moved: '0', tx_hash: null },
            });
          }
        }
        await completeRun(eng.db, eng.log, run.run_id);
        return ok({ ok: true });
      },
    },
    { method: 'GET', path: new RegExp(`^/v1/mandates/${ID}$`), handler: async ({ params }) => mandateView(eng, params[0]!) },
    {
      method: 'GET',
      path: /^\/v1\/receipts$/,
      handler: async ({ url }) => ok({ receipts: await settlementReceipts(eng.db, url.searchParams.get('mandate_id') ?? 'M-001') }),
    },
    { method: 'GET', path: new RegExp(`^/v1/receipts/${ID}$`), handler: async ({ params }) => ok(await receiptBundle(eng.db, params[0]!)) },
  ];

  const corsFor = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (req.method === 'GET' || req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'GET') {
      return { 'access-control-allow-origin': '*' };
    }
    if (origin === undefined) return {};
    if (deps.webOrigins.includes(origin)) return { 'access-control-allow-origin': origin, vary: 'Origin' };
    throw new HttpError(403, `origin ${origin} may not call this endpoint`);
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    let cors: Record<string, string> = {};
    try {
      const url = new URL(req.url ?? '/', 'http://api.local');
      cors = corsFor(req);
      if (req.method === 'OPTIONS') {
        res
          .writeHead(204, {
            ...cors,
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type, authorization, idempotency-key, last-event-id',
            'access-control-max-age': '600',
          })
          .end();
        return;
      }
      const matching = routes.filter((r) => r.path.test(url.pathname));
      const route = matching.find((r) => r.method === req.method);
      if (!route) throw new HttpError(matching.length > 0 ? 405 : 404, matching.length > 0 ? 'method not allowed' : 'not found');
      if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new HttpError(415, 'POST bodies must be application/json');
      }
      const params = (route.path.exec(url.pathname) ?? []).slice(1);
      const reply = await route.handler({ req, res, params, url, cors });
      if (reply) send(res, reply, cors);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        send(res, { status: error.status, body: { error: error.message }, headers: error.headers }, cors);
        return;
      }
      console.error(error);
      send(res, { status: 500, body: { error: 'internal error' } }, cors);
    }
  };
}
