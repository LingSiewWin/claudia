// Checks a running Authority API against the HTTP/SSE contract this app renders.
// Usage: API_BASE=https://<api> pnpm --filter @authority/web contract-check
import assert from 'node:assert/strict';
import { canonicalJson, concatBytes, hexToBytes, sha256Hex, utf8ToBytes } from '@authority/core';
import type { MandateView, ReceiptBundle, RunEvent, RunSummary } from '../lib/contract';

const base = process.env.API_BASE;
if (!base) throw new Error('set API_BASE');
const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
};
const TYPES = new Set([
  'RunStarted', 'ActionProposed', 'AuthorityEvaluationStarted', 'AuthorityEvaluated', 'CREVerificationStarted',
  'CREVerificationCompleted', 'AuthorizationIssued', 'ApprovalRequested', 'CFOApproved', 'CFODeclined', 'ActionDenied',
  'TransactionBuilt', 'TransactionSubmitted', 'TransactionConfirmed', 'TransactionRejected', 'ReceiptProven',
  'AttackStarted', 'AttackResult', 'MandateUpdated', 'MandateRevoked', 'RunCompleted',
]);

const { runs } = await get<{ runs: RunSummary[] }>('/v1/runs?kind=all');
const stage = runs.find((r) => r.kind === 'stage');
assert.ok(stage, 'no recorded stage run');
const { events } = await get<{ run: RunSummary; events: RunEvent[] }>(`/v1/runs/${stage.run_id}/log`);
assert.equal(events[0]?.type, 'RunStarted', 'first event of a run must be RunStarted');
let lastSeq = 0;
for (const e of events) {
  assert.ok(TYPES.has(e.type), `unknown event type ${e.type}`);
  assert.ok(e.seq > lastSeq, `seq not increasing at ${e.seq}`);
  lastSeq = e.seq;
  const { hash, prev_hash, ...body } = e;
  assert.equal(sha256Hex(concatBytes(hexToBytes(prev_hash), utf8ToBytes(canonicalJson(body)))), hash, `bad hash at seq ${e.seq}`);
}
const started = events[0] as Extract<RunEvent, { type: 'RunStarted' }>;
for (const k of ['autonomous_limit', 'hard_cap', 'daily_cap', 'treasury_minimum'] as const) {
  assert.match(started.payload.limits[k], /^\d+$/, `RunStarted.limits.${k}`);
}
assert.match(started.payload.vault.balance, /^\d+$/, 'RunStarted.vault.balance');
assert.match(started.payload.vault.spent_today, /^\d+$/, 'RunStarted.vault.spent_today');
const mandate = await get<MandateView>('/v1/mandates/M-001');
assert.match(mandate.vault.balance, /^\d+$/);
assert.ok(['active', 'revoked'].includes(mandate.anchor.status));
const { receipts } = await get<{ receipts: Array<{ receipt_id: string }> }>('/v1/receipts?mandate_id=M-001');
const first = receipts[0];
assert.ok(first, 'no receipts yet');
const bundle = await get<ReceiptBundle>(`/v1/receipts/${first.receipt_id}`);
assert.equal(bundle.receipt.schema, 'receipt/v0.1');
assert.equal(bundle.authorization.schema, 'authorization/v0.1');
assert.equal(bundle.mandate.schema, 'mandate/v0.1');
const sse = await fetch(`${base}/v1/runs/${stage.run_id}/events`, { signal: AbortSignal.timeout(5_000) });
assert.equal(sse.headers.get('content-type')?.split(';')[0], 'text/event-stream');
assert.ok(sse.headers.get('access-control-allow-origin'), 'SSE needs Access-Control-Allow-Origin for the Vercel origin');
const reader = sse.body?.getReader();
const chunk = new TextDecoder().decode((await reader?.read())?.value);
await reader?.cancel();
assert.match(chunk, /(^|\n)(id: \d+|retry: \d+)/, 'SSE frames must carry id: <seq>');
console.log(`contract ok: ${runs.length} runs, stage run ${stage.run_id} with ${events.length} hash-valid events, receipt ${first.receipt_id}`);
