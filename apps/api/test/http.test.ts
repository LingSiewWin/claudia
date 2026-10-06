import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { action, AGENT_KEY, type Api, inv, signed, startApi, WEB } from './harness';

let api: Api;
beforeEach(async () => {
  api = await startApi();
});
afterEach(() => api.close());

const frames = async (runId: string, lastEventId?: string, wantIds = 1) => {
  const ctrl = new AbortController();
  const res = await fetch(`${api.url}/v1/runs/${runId}/events`, { signal: ctrl.signal, headers: lastEventId ? { 'last-event-id': lastEventId } : {} });
  const reader = res.body!.getReader();
  let text = '';
  while ((text.match(/^id: /gm) ?? []).length < wantIds) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  return { res, text, ids: [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])) };
};

describe('SSE event stream', () => {
  it('replays stored events as id/data frames, then live ones, each once, and resumes after Last-Event-ID', async () => {
    const run = await api.agentRun();
    const stored = await api.log(run);
    const first = await frames(run, undefined, stored.length);
    expect(first.res.headers.get('content-type')).toBe('text/event-stream');
    expect(first.res.headers.get('access-control-allow-origin')).toBe('*');
    expect(first.text.startsWith('retry: 3000\n\n')).toBe(true);
    expect(first.ids).toEqual(stored.map((e) => e.seq));
    expect(first.text).not.toMatch(/^event:/m);
    const data = JSON.parse(/^data: (.*)$/m.exec(first.text)![1]!);
    expect(data).toEqual(stored[0]);

    // live: a check on the run streams after a resume from the last stored id
    const ctrl = new AbortController();
    const res = await fetch(`${api.url}/v1/runs/${run}/events`, { signal: ctrl.signal, headers: { 'last-event-id': String(stored.at(-1)!.seq) } });
    const reader = res.body!.getReader();
    await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-5', invoice: inv('INV-3825') })), execute: true, run_id: run });
    let text = '';
    while (!text.includes('ActionDenied')) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    const after = (await api.log(run)).filter((e) => e.seq > stored.at(-1)!.seq).map((e) => e.seq);
    expect(ids).toEqual(after);
  });

  it('404 for an unknown run, before any stream starts', async () => {
    const res = await fetch(`${api.url}/v1/runs/11111111-1111-4111-8111-111111111111/events`);
    expect(res.status).toBe(404);
  });
});

describe('HTTP surface', () => {
  it('GETs are public with CORS *; POSTs from a foreign browser origin are refused; the web origin is echoed', async () => {
    expect((await api.get('/v1/runs?kind=all')).headers.get('access-control-allow-origin')).toBe('*');
    const foreign = await api.post('/v1/runs', { mandate_id: 'M-001' }, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    const ours = await api.post('/v1/runs', { mandate_id: 'M-001' }, { origin: WEB });
    expect(ours.status).toBe(200);
    expect(ours.headers.get('access-control-allow-origin')).toBe(WEB);
    const preflight = await fetch(`${api.url}/v1/approvals/AP-1/decline`, { method: 'OPTIONS', headers: { origin: WEB, 'access-control-request-method': 'POST' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/idempotency-key/);
  });

  it('POST needs a JSON content type; unknown paths are 404, wrong methods 405, errors are { error }', async () => {
    const res = await fetch(`${api.url}/v1/runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"mandate_id":"M-001"}' });
    expect(res.status).toBe(415);
    expect((await api.get('/v1/nope')).status).toBe(404);
    const wrong = await api.get('/v1/authority/check');
    expect(wrong.status).toBe(405);
    expect(wrong.json).toEqual({ error: 'method not allowed' });
  });

  it('one live stage run at a time: a second Run is told to retry (429)', async () => {
    expect((await api.post('/v1/runs', { mandate_id: 'M-001' })).status).toBe(200);
    const second = await api.post('/v1/runs', { mandate_id: 'M-001' });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('30');
    expect((await api.post('/v1/runs', { mandate_id: 'M-LAB' })).status).toBe(400);
  });

  it('the agent claims pending runs with its key only; RunStarted carries limits and the vault read from Cardano', async () => {
    expect((await api.post('/v1/agent/runs/claim', {})).status).toBe(401);
    expect((await api.post('/v1/agent/runs/claim', {}, { authorization: `Bearer ${AGENT_KEY}` })).status).toBe(204);
    const { run_id } = (await api.post('/v1/runs', { mandate_id: 'M-001' })).json;
    const claimed = await api.post('/v1/agent/runs/claim', {}, { authorization: `Bearer ${AGENT_KEY}` });
    expect(claimed.json).toMatchObject({ run_id, kind: 'stage', mandate_id: 'M-001', attack: null });
    const [started] = await api.log(run_id);
    expect(started!.payload).toMatchObject({
      kind: 'stage',
      mandate_version: 3,
      principal: 'Acme Corp',
      delegate: 'CFO-Agent-01',
      limits: { symbol: 'USDM', decimals: 6, autonomous_limit: '10000000', hard_cap: '50000000', daily_cap: '50000000', treasury_minimum: '100000000' },
      vault: { balance: '135000000', spent_today: '0' },
    });
  });

  it('mandate view reads the live anchor and vault; yesterday\'s spend does not count today', async () => {
    const chain = api.chains.get(api.b001.vaultHash)!;
    chain.spent = 26_420_000n;
    chain.day -= 1;
    const view = (await api.get('/v1/mandates/M-001')).json;
    expect(view.vault).toMatchObject({ balance: '135000000', spent_today: '0', last_nonce: '0' });
    expect(view.anchor).toMatchObject({ version: 3, status: 'active', mandate_ref: 'bb'.repeat(28) });
    expect(view.limits.hard_cap).toBe('50000000');
  });

  it('the run log reports its closing anchor, null while none has been recorded', async () => {
    const run = await api.agentRun();
    const log = (await api.get(`/v1/runs/${run}/log`)).json;
    expect(log).toMatchObject({ run: { run_id: run, kind: 'stage' }, anchor: null });
    expect(log.events.map((e: { type: string }) => e.type)).toEqual(['RunStarted']);
  });
});
