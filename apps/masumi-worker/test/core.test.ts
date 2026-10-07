import { describe, expect, it } from 'vitest';
import { CoreError, createCoreClient } from '../src/core';

const KEY = 'coworker_abc123';
const task = (id: string) => ({ id, name: 'Authority check', description: null, status: 'READY', assigneeId: 'cw', organizationId: null, extra: 'ignored' });

function recorder(pages: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const hit = pages[String(url)];
    if (!hit) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('Sokosumi Core client', () => {
  it('only accepts a coworker key', () => {
    expect(() => createCoreClient({ apiKey: 'sk_user_token' })).toThrow(/coworker_/);
  });

  it('lists READY tasks across pages with the coworker bearer key', async () => {
    const base = 'https://core.example';
    const { calls, fetchImpl } = recorder({
      [`${base}/v1/tasks?status=READY&limit=100`]: { body: { data: [task('t1')], meta: { pagination: { nextCursor: 't1' } } } },
      [`${base}/v1/tasks?status=READY&limit=100&cursor=t1`]: { body: { data: [task('t2')], meta: { pagination: { nextCursor: null } } } },
    });
    const core = createCoreClient({ apiKey: KEY, baseUrl: base, fetchImpl });
    expect((await core.readyTasks()).map((t) => t.id)).toEqual(['t1', 't2']);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('posts Task events to /v1/tasks/{id}/events', async () => {
    const base = 'https://core.example';
    const { calls, fetchImpl } = recorder({ [`${base}/v1/tasks/t1/events`]: { status: 201, body: { data: { id: 'ev1', status: 'RUNNING' } } } });
    const core = createCoreClient({ apiKey: KEY, baseUrl: base, fetchImpl });
    expect(await core.postEvent('t1', { status: 'RUNNING' })).toEqual({ id: 'ev1', status: 'RUNNING' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: 'RUNNING' });
  });

  it('errors carry the HTTP status and the Core error kind', async () => {
    const base = 'https://core.example';
    const { fetchImpl } = recorder({ [`${base}/v1/tasks/t1/events`]: { status: 403, body: { kind: 'grant_required' } } });
    const core = createCoreClient({ apiKey: KEY, baseUrl: base, fetchImpl });
    const err = await core.postEvent('t1', { status: 'RUNNING' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect(err).toMatchObject({ status: 403, message: expect.stringContaining('grant_required') });
  });

  it('rejects unsafe task ids before any request', async () => {
    const { calls, fetchImpl } = recorder({});
    await expect(createCoreClient({ apiKey: KEY, fetchImpl }).getTask('../admin')).rejects.toThrow(/invalid task id/);
    expect(calls).toHaveLength(0);
  });
});
