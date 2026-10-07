import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/koios/tx_info/route';

const call = (body: string) => POST(new Request('http://localhost/api/koios/tx_info', { method: 'POST', body }));

afterEach(() => vi.unstubAllGlobals());

describe('Koios relay (transport only)', () => {
  it('refuses bodies above the Koios public-tier limit, counted in bytes', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    expect((await call('x'.repeat(5121))).status).toBe(413);
    expect((await call('é'.repeat(2561))).status).toBe(413); // 2561 characters, 5122 bytes
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    const request = {
      headers: new Headers({ 'Content-Length': '5121' }),
      arrayBuffer,
    } as unknown as Request;
    const res = await POST(request);
    expect(res.status).toBe(413);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards the exact request bytes and returns the upstream status and body untouched', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => new Response('[{"tx_hash":"ab"}]', { status: 202, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', upstream);
    const res = await call('{"_tx_hashes":["ab"]}');
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('[{"tx_hash":"ab"}]');
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('https://preprod.koios.rest/api/v1/tx_info');
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"_tx_hashes":["ab"]}');
  });

  it('turns an unreachable Koios into an error, never into data or a verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const res = await call('{"_tx_hashes":["ab"]}');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Koios unreachable' });
  });
});
