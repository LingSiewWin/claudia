import { canonicalJson } from '@authority/core';
import { decisionHash } from '@authority/masumi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityContractError, AuthorityError, buildOutput, createAuthorityClient } from '../src/authority';
import { SIGNED_INPUT, WEB, authorityResponse, authorizationRecord, startFakeAuthority } from './fakes';

describe('authority client against a local fake of the API', () => {
  let api: Awaited<ReturnType<typeof startFakeAuthority>>;
  beforeAll(async () => {
    api = await startFakeAuthority();
  });
  afterAll(() => api.close());

  it('sends the bearer key, the idempotency key, and never asks for execution', async () => {
    const client = createAuthorityClient({ baseUrl: `${api.url}/`, apiKey: 'worker-key' });
    const res = await client.check(SIGNED_INPUT, 'masumi:aabbccddeeff00112233');
    expect(res.evaluation.outcome).toBe('ALLOW');
    const call = api.calls.at(-1);
    expect(call?.auth).toBe('Bearer worker-key');
    expect(call?.key).toBe('masumi:aabbccddeeff00112233');
    expect(call?.body).toEqual({ ...SIGNED_INPUT, execute: false });
  });

  it('a repeated idempotency key returns the stored decision without a second evaluation', async () => {
    const client = createAuthorityClient({ baseUrl: api.url, apiKey: 'k' });
    const before = api.evaluations();
    const a = await client.check(SIGNED_INPUT, 'sokosumi:task-1');
    const b = await client.check(SIGNED_INPUT, 'sokosumi:task-1');
    expect(b).toEqual(a);
    expect(api.evaluations()).toBe(before + 1);
  });
});

describe('authority client errors', () => {
  it('HTTP 503 is a retryable AuthorityError', async () => {
    const api = await startFakeAuthority(() => ({ status: 503, json: { error: 'busy' } }));
    await expect(createAuthorityClient({ baseUrl: api.url, apiKey: 'k' }).check(SIGNED_INPUT, 'k1')).rejects.toMatchObject({ status: 503, transient: true });
    await api.close();
  });

  it('HTTP 429 is transient and carries Retry-After in milliseconds', async () => {
    const api = await startFakeAuthority(() => ({ status: 429, json: { error: 'still running' }, headers: { 'retry-after': '120' } }));
    await expect(createAuthorityClient({ baseUrl: api.url, apiKey: 'k' }).check(SIGNED_INPUT, 'k3')).rejects.toMatchObject({
      status: 429,
      transient: true,
      retryAfterMs: 120_000,
    });
    await api.close();
  });

  it('HTTP 408 is transient; no Retry-After means no hint', async () => {
    const api = await startFakeAuthority(() => ({ status: 408, json: { error: 'timeout' } }));
    await expect(createAuthorityClient({ baseUrl: api.url, apiKey: 'k' }).check(SIGNED_INPUT, 'k4')).rejects.toMatchObject({
      status: 408,
      transient: true,
      retryAfterMs: null,
    });
    await api.close();
  });

  it('a response outside the contract is an AuthorityContractError', async () => {
    const broken = { ...authorityResponse(), receipt_hash: undefined };
    const api = await startFakeAuthority(() => ({ status: 200, json: broken }));
    await expect(createAuthorityClient({ baseUrl: api.url, apiKey: 'k' }).check(SIGNED_INPUT, 'k2')).rejects.toBeInstanceOf(AuthorityContractError);
    await api.close();
  });

  it('AuthorityError carries the status; other 4xx are permanent', () => {
    const e = new AuthorityError('x', 400);
    expect(e.status).toBe(400);
    expect(e.transient).toBe(false);
    expect(e.retryAfterMs).toBeNull();
  });
});

describe('buildOutput (the sold result)', () => {
  it('signed ALLOW: decision, checks, verification, authorization intact, receipt link, decision hash', () => {
    const res = authorityResponse({ outcome: 'ALLOW' });
    const { output, resultText } = buildOutput(res as never, `${WEB}/`);
    expect(output).toEqual({
      decision: 'ALLOW',
      reason: null,
      checks: res.evaluation.checks,
      interpreted_action: null,
      verification: res.verification,
      authorization: authorizationRecord(false),
      receipt: { id: 'R-0001', url: `${WEB}/receipt/R-0001`, hash: '11'.repeat(32) },
      decision_hash: decisionHash('dd'.repeat(32), 'cc'.repeat(32), 'ee'.repeat(32), 'ALLOW'),
    });
    expect(resultText).toBe(canonicalJson(output));
  });

  it('unsigned: full evaluation, no authorization, marked evaluation only', () => {
    const res = authorityResponse({ signed: false, interpreted: { note: 'interpreted' } });
    const { output } = buildOutput(res as never, WEB);
    expect(output.authorization).toBeNull();
    expect(output.notice).toBe('unsigned: evaluation only');
    expect(output.interpreted_action).toEqual({ note: 'interpreted' });
  });

  it('REQUIRE_APPROVAL may carry an authorization that requires the principal', () => {
    const { output } = buildOutput(authorityResponse({ outcome: 'REQUIRE_APPROVAL' }) as never, WEB);
    expect((output.authorization as { fields: { requires_principal: boolean } }).fields.requires_principal).toBe(true);
  });

  it.each([
    ['authorization for an unsigned proposal (compromised API)', { signed: false, authorization: authorizationRecord(false) }],
    ['authorization for a DENY', { outcome: 'DENY' as const, authorization: authorizationRecord(false) }],
    ['REQUIRE_APPROVAL authorization without the principal flag', { outcome: 'REQUIRE_APPROVAL' as const, authorization: authorizationRecord(false) }],
  ])('refuses to sell %s', (_label, o) => {
    expect(() => buildOutput(authorityResponse(o) as never, WEB)).toThrow(AuthorityContractError);
  });
});
