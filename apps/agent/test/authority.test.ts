import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthorityError, httpAuthority, withRetry } from '../src/authority';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});
async function serve(reply: (path: string) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const seen: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      seen.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      const r = reply(req.url!);
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers }).end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  close = () => new Promise<void>((r) => server.close(() => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe('httpAuthority', () => {
  it('sends the bearer key and the idempotency key, and maps 204 to null', async () => {
    const { url, seen } = await serve((p) => (p.endsWith('/claim') ? { status: 204 } : { status: 200, body: { evaluation: { outcome: 'DENY', reason: 'X' } } }));
    const api = httpAuthority({ url, key: 'agent-key-0123456789abcdef0123456789' });
    expect(await api.claim()).toBeNull();
    await api.check({ mandate_id: 'M-001', proposal: { action: {}, agent_signature: 'ab' }, execute: true, run_id: 'r' }, 'agent:r:A-1');
    expect(seen.map((s) => [s.method, s.path, s.headers.authorization, s.headers['idempotency-key'] ?? null])).toEqual([
      ['POST', '/v1/agent/runs/claim', 'Bearer agent-key-0123456789abcdef0123456789', null],
      ['POST', '/v1/authority/check', 'Bearer agent-key-0123456789abcdef0123456789', 'agent:r:A-1'],
    ]);
    expect(JSON.parse(seen[1]!.body)).toEqual({ mandate_id: 'M-001', proposal: { action: {}, agent_signature: 'ab' }, execute: true, run_id: 'r' });
  });

  it('maps API errors with their status and Retry-After', async () => {
    const { url } = await serve(() => ({ status: 429, body: { error: 'a stage run is already in progress' }, headers: { 'retry-after': '30' } }));
    const error = await httpAuthority({ url, key: 'k'.repeat(32) }).work('r').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorityError);
    expect(error).toMatchObject({ status: 429, retryAfterS: 30, transient: true, message: 'GET /v1/agent/runs/r/work: a stage run is already in progress' });
  });
});

describe('withRetry', () => {
  it('retries transient errors only', async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 3) throw new AuthorityError(503, 'down', 2);
        return 'ok';
      },
      { attempts: 5, sleep: async (ms) => void waits.push(ms) },
    );
    expect([out, waits]).toEqual(['ok', [2000, 2000]]);
    await expect(withRetry(async () => Promise.reject(new AuthorityError(409, 'run is finished', null)), { attempts: 5, sleep: async () => undefined })).rejects.toMatchObject({ status: 409 });
  });
});
