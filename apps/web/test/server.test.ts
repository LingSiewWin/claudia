import { type ChildProcess, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const port = 8791;
const base = `http://localhost:${port}`;
let child: ChildProcess;

const post = (path: string, body?: string) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) });
const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

beforeAll(async () => {
  child = spawn('pnpm', ['exec', 'tsx', 'fixtures/server.ts'], { env: { ...process.env, FIXTURE_API_PORT: String(port), FIXTURE_SSE_PACE_MS: '10' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await get('/v1/runs').then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('fixture server did not start');
}, 20_000);
afterAll(() => {
  child.kill();
});

describe('fixture server survives bad input', () => {
  it('malformed JSON to decline -> 400', async () => {
    expect((await post('/v1/approvals/AP-A-0002/decline', '{nope')).status).toBe(400);
  });
  it('empty body to attacks -> 400', async () => {
    expect((await post('/v1/lab/attacks')).status).toBe(400);
  });
  it('unknown mandate on revoke -> 404', async () => {
    expect((await post('/v1/mandates/M-NOPE/revoke', '{}')).status).toBe(404);
  });
  it('koios {} -> 400', async () => {
    expect((await post('/koios/tx_info', '{}')).status).toBe(400);
  });
  it.each(['__proto__', 'constructor', 'toString'])('prototype key %s is not a mandate, run, approval or receipt', async (k) => {
    expect((await get(`/v1/mandates/${k}`)).status).toBe(404);
    expect((await post(`/v1/mandates/${k}/revoke`, '{}')).status).toBe(404);
    expect((await post(`/v1/mandates/${k}/submit`, '{"tx_hash":"a"}')).status).toBe(404);
    expect((await get(`/v1/runs/${k}/log`)).status).toBe(404);
    expect((await get(`/v1/runs/${k}/events`)).status).toBe(404);
    expect((await post(`/v1/approvals/${k}/approve`, '{}')).status).toBe(404);
    expect((await get(`/v1/receipts/${k}`)).status).toBe(404);
    expect((await post('/v1/lab/attacks', JSON.stringify({ attack: k }))).status).toBe(404);
  });
  it('prototype keys in a koios or sepolia body find nothing', async () => {
    expect(await (await post('/koios/tx_info', '{"_tx_hashes":["__proto__","constructor"]}')).json()).toEqual([]);
    const r = (await (await post('/sepolia', '{"params":["__proto__"]}')).json()) as { result: unknown };
    expect(r.result).toBeNull();
  });
  it('malformed percent escape -> 400', async () => {
    expect((await get('/v1/mandates/%E0%A4%A')).status).toBe(400);
    expect((await post('/v1/mandates/%zz/revoke', '{}')).status).toBe(400);
  });
  it('is still alive afterwards', async () => {
    expect((await get('/v1/runs')).status).toBe(200);
  });
});

describe('fixture server matches the contract', () => {
  it('lists runs newest first and honours kind and mandate_id', async () => {
    const all = ((await (await get('/v1/runs?kind=all')).json()) as { runs: { started_at: string; mandate_id: string }[] }).runs;
    expect(all.map((r) => r.started_at)).toEqual([...all.map((r) => r.started_at)].sort().reverse());
    const lab = ((await (await get('/v1/runs?mandate_id=M-LAB')).json()) as { runs: { mandate_id: string }[] }).runs;
    expect(lab.length).toBe(9);
    expect(lab.every((r) => r.mandate_id === 'M-LAB')).toBe(true);
  });
  it('filters approvals by status and receipts by mandate', async () => {
    expect(((await (await get('/v1/approvals?status=pending')).json()) as { approvals: unknown[] }).approvals).toHaveLength(1);
    expect(((await (await get('/v1/approvals?status=approved')).json()) as { approvals: unknown[] }).approvals).toHaveLength(0);
    expect(((await (await get('/v1/receipts?mandate_id=M-001')).json()) as { receipts: unknown[] }).receipts).toHaveLength(2);
    expect(((await (await get('/v1/receipts?mandate_id=M-LAB')).json()) as { receipts: unknown[] }).receipts).toHaveLength(0);
  });
  it('answers 405 for the wrong method', async () => {
    expect((await get('/v1/approvals/AP-A-0002/approve')).status).toBe(405);
    expect((await post('/v1/runs?kind=all', '{}')).status).toBe(200); // POST /v1/runs starts a run
    expect((await post('/v1/receipts', '{}')).status).toBe(405);
  });
  it('unknown run events -> 404; non-numeric Last-Event-ID replays from the start', async () => {
    expect((await get('/v1/runs/run-nope/events')).status).toBe(404);
    const res = await get('/v1/runs/run-lab-replay/events', { 'Last-Event-ID': 'abc' });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toMatch(/id: \d+\ndata: \{"seq":\d+/);
  });
});
