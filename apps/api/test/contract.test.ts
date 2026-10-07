import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalJson, concatBytes, decisionHash, hexToBytes, sha256Hex, utf8ToBytes } from '@authority/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { action, ADDR, type Api, inv, MASUMI_KEY, signed, startApi } from './harness';
import { runStage } from './stage';

// The web app's checker (apps/web/scripts/contract-check.ts) and the Masumi worker's response schema
// (apps/masumi-worker/src/authority.ts) are run against this API when those apps are in the workspace.
// Until then the mirrors below assert the same things, one for one.
const WEB_CHECKER = fileURLToPath(new URL('../../web/scripts/contract-check.ts', import.meta.url));
const WORKER_CLIENT = fileURLToPath(new URL('../../masumi-worker/src/authority.ts', import.meta.url));

let api: Api;
let run: string;
beforeAll(async () => {
  api = await startApi();
  ({ run } = await runStage(api));
});
afterAll(() => api.close());

const EVENT_TYPES = new Set([
  'RunStarted', 'ActionProposed', 'AuthorityEvaluationStarted', 'AuthorityEvaluated', 'CREVerificationStarted',
  'CREVerificationCompleted', 'AuthorizationIssued', 'ApprovalRequested', 'CFOApproved', 'CFODeclined', 'ActionDenied',
  'TransactionBuilt', 'TransactionSubmitted', 'TransactionConfirmed', 'TransactionRejected', 'ReceiptProven',
  'AttackStarted', 'AttackResult', 'MandateUpdated', 'MandateRevoked', 'RunCompleted',
]);

describe('web contract (what /live, /console, /mandate and /receipt render)', () => {
  it('mirror of the web checker: runs, hash-valid log, RunStarted fields, mandate view, receipts, SSE framing', async () => {
    const { runs } = (await api.get('/v1/runs?kind=all')).json;
    const stage = runs.find((r: { kind: string }) => r.kind === 'stage');
    expect(stage.run_id).toBe(run);
    const { events } = (await api.get(`/v1/runs/${stage.run_id}/log`)).json;
    expect(events[0].type).toBe('RunStarted');
    let lastSeq = 0;
    for (const e of events) {
      expect(EVENT_TYPES.has(e.type)).toBe(true);
      expect(e.seq).toBeGreaterThan(lastSeq);
      lastSeq = e.seq;
      const { hash, prev_hash, ...body } = e;
      expect(sha256Hex(concatBytes(hexToBytes(prev_hash), utf8ToBytes(canonicalJson(body))))).toBe(hash);
    }
    for (const k of ['autonomous_limit', 'hard_cap', 'daily_cap', 'treasury_minimum']) expect(events[0].payload.limits[k]).toMatch(/^\d+$/);
    expect(events[0].payload.vault.balance).toMatch(/^\d+$/);
    expect(events[0].payload.vault.spent_today).toMatch(/^\d+$/);
    const mandate = (await api.get('/v1/mandates/M-001')).json;
    expect(mandate.vault.balance).toMatch(/^\d+$/);
    expect(['active', 'revoked']).toContain(mandate.anchor.status);
    const { receipts } = (await api.get('/v1/receipts?mandate_id=M-001')).json;
    const bundle = (await api.get(`/v1/receipts/${receipts[0].receipt_id}`)).json;
    expect([bundle.receipt.schema, bundle.authorization.schema, bundle.mandate.schema]).toEqual(['receipt/v0.1', 'authorization/v0.1', 'mandate/v0.1']);
    const sse = await fetch(`${api.url}/v1/runs/${stage.run_id}/events`, { signal: AbortSignal.timeout(5_000) });
    expect(sse.headers.get('content-type')?.split(';')[0]).toBe('text/event-stream');
    expect(sse.headers.get('access-control-allow-origin')).toBeTruthy();
    const reader = sse.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(chunk).toMatch(/(^|\n)(id: \d+|retry: \d+)/);
  });

  it.skipIf(!existsSync(WEB_CHECKER))('the web app checker itself passes', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', WEB_CHECKER], {
      env: { ...process.env, API_BASE: api.url },
      timeout: 60_000,
    });
    expect(stdout).toMatch(/^contract ok: /);
  });
});

// Mirror of AuthorityResponseSchema in the Masumi worker (the slice it depends on).
const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const WorkerResponse = z.object({
  evaluation: z.object({
    outcome: z.enum(['ALLOW', 'ESCALATE', 'DENY']),
    reason: z.string().nullable(),
    checks: z.array(z.unknown()),
    signed: z.boolean(),
    action_hash: Hex32.nullable(),
    mandate_hash: Hex32,
    verification_hash: Hex32.nullable(),
  }),
  interpreted_action: z.unknown().optional(),
  verification: z.object({ report_hash: Hex32, sepolia_tx: z.string(), facts: z.record(z.string(), z.unknown()) }).nullable().optional(),
  authorization: z.looseObject({ schema: z.literal('authorization/v0.1'), fields: z.looseObject({ requires_principal: z.boolean() }) }).nullable().optional(),
  receipt_id: z.string().min(1),
  receipt_hash: Hex32,
  events_url: z.string(),
});

describe('Masumi worker contract', () => {
  const cases = [
    ['ALLOW', () => signed(action({ id: 'M-1', invoice: inv('INV-L-0001') }))],
    ['ESCALATE', () => signed(action({ id: 'M-2', invoice: inv('INV-G-0042'), counterparty: ['globex', 'Globex (demo vendor)'] }))],
    ['DENY', () => signed(action({ id: 'M-3', invoice: inv('INV-3823'), recipient: ADDR.attacker }))],
    ['ALLOW', () => ({ action: action({ id: 'M-4', invoice: inv('INV-L-0001') }), agent_signature: null })],
  ] as const;

  it.each(cases)('%s matches the schema, decision hash, and authorization rules', async (outcome, proposal) => {
    const res = await api.check({ mandate_id: 'M-001', proposal: proposal(), execute: false }, { key: MASUMI_KEY });
    expect(res.status).toBe(200);
    const body = WorkerResponse.parse(res.json);
    const e = body.evaluation;
    expect(e.outcome).toBe(outcome);
    expect(res.json.decision_hash).toBe(decisionHash(e.action_hash, e.mandate_hash, e.verification_hash, e.outcome));
    if (body.authorization) {
      expect(e.signed).toBe(true);
      expect(e.outcome).not.toBe('DENY');
      if (e.outcome === 'ESCALATE') expect(body.authorization.fields.requires_principal).toBe(true);
    }
    if (!e.signed) expect(res.json.notice).toBe('unsigned: evaluation only');
  });

  it.skipIf(!existsSync(WORKER_CLIENT))('the worker parses and sells every reply', async () => {
    const worker = (await import(WORKER_CLIENT)) as { AuthorityResponseSchema: z.ZodType; buildOutput: (r: unknown, web: string) => unknown };
    for (const [, proposal] of cases) {
      const res = await api.check({ mandate_id: 'M-001', proposal: proposal(), execute: false }, { key: MASUMI_KEY });
      expect(() => worker.buildOutput(worker.AuthorityResponseSchema.parse(res.json), 'https://web.test')).not.toThrow();
    }
  });
});
