import { canonicalJson } from '@authority/core';
import { decisionHash } from '@authority/masumi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityContractError, AuthorityError, buildOutput, createAuthorityClient } from '../src/authority';
import {
  ENGINE_PUBLIC_KEY,
  ESCALATION,
  OTHER_ENGINE_SECRET_KEY,
  PRICE,
  SIGNED_INPUT,
  WEB,
  authorityResponse,
  authorizationRecord,
  brief,
  startFakeAuthority,
} from './fakes';

const clientFor = (url: string) => createAuthorityClient({ baseUrl: url, apiKey: 'k', enginePublicKey: ENGINE_PUBLIC_KEY });
const UNSIGNED_INPUT = { mandate_id: 'M-001', proposal: { ...SIGNED_INPUT.proposal, agent_signature: null } };
const TEXT_INPUT = { mandate_id: 'M-001', request_text: 'pay the AWS invoice' };

describe('authority client against a local fake of the API', () => {
  let api: Awaited<ReturnType<typeof startFakeAuthority>>;
  beforeAll(async () => {
    api = await startFakeAuthority();
  });
  afterAll(() => api.close());

  it('sends the bearer key, the idempotency key, and never asks for execution', async () => {
    const client = createAuthorityClient({ baseUrl: `${api.url}/`, apiKey: 'worker-key', enginePublicKey: `ed25519:${ENGINE_PUBLIC_KEY}` });
    const res = await client.check(SIGNED_INPUT, 'masumi:aabbccddeeff00112233');
    expect(res.evaluation.outcome).toBe('ALLOW');
    expect(res.authorization?.fields.amount).toBe('8420000');
    const call = api.calls.at(-1);
    expect(call?.auth).toBe('Bearer worker-key');
    expect(call?.key).toBe('masumi:aabbccddeeff00112233');
    expect(call?.body).toEqual({ ...SIGNED_INPUT, execute: false });
  });

  it('a repeated idempotency key returns the stored decision without a second evaluation', async () => {
    const client = clientFor(api.url);
    const before = api.evaluations();
    const a = await client.check(SIGNED_INPUT, 'sokosumi:task-1');
    const b = await client.check(SIGNED_INPUT, 'sokosumi:task-1');
    expect(b).toEqual(a);
    expect(api.evaluations()).toBe(before + 1);
  });

  it('unsigned and plain-English requests come back as evaluation only', async () => {
    const client = clientFor(api.url);
    expect((await client.check(UNSIGNED_INPUT, 'u1')).authorization).toBeNull();
    expect((await client.check(TEXT_INPUT, 't1')).authorization).toBeNull();
  });

  it('refuses an engine public key that is not 32 bytes of hex', () => {
    expect(() => createAuthorityClient({ baseUrl: api.url, apiKey: 'k', enginePublicKey: '' })).toThrow(TypeError);
    expect(() => createAuthorityClient({ baseUrl: api.url, apiKey: 'k', enginePublicKey: 'ab'.repeat(31) })).toThrow(TypeError);
  });
});

describe('authority client errors', () => {
  it('HTTP 503 is a retryable AuthorityError', async () => {
    const api = await startFakeAuthority(() => ({ status: 503, json: { error: 'busy' } }));
    await expect(clientFor(api.url).check(SIGNED_INPUT, 'k1')).rejects.toMatchObject({ status: 503, transient: true });
    await api.close();
  });

  it('HTTP 429 is transient and carries Retry-After in milliseconds', async () => {
    const api = await startFakeAuthority(() => ({ status: 429, json: { error: 'still running' }, headers: { 'retry-after': '120' } }));
    await expect(clientFor(api.url).check(SIGNED_INPUT, 'k3')).rejects.toMatchObject({
      status: 429,
      transient: true,
      retryAfterMs: 120_000,
    });
    await api.close();
  });

  it('Retry-After never points past the result deadline', async () => {
    const api = await startFakeAuthority(() => ({ status: 429, json: {}, headers: { 'retry-after': '99999999999' } }));
    const deadlineMs = Date.now() + 30_000;
    const err = await clientFor(api.url).check(SIGNED_INPUT, 'k5', { deadlineMs }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthorityError);
    const wait = (err as AuthorityError).retryAfterMs!;
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThanOrEqual(30_000);
    const past = await clientFor(api.url).check(SIGNED_INPUT, 'k6', { deadlineMs: Date.now() - 1 }).catch((e: unknown) => e);
    expect((past as AuthorityError).retryAfterMs).toBe(0);
    await api.close();
  });

  it('Retry-After as an HTTP date; anything else gives no hint', async () => {
    const at = new Date(Date.now() + 60_000).toUTCString();
    const dated = await startFakeAuthority(() => ({ status: 503, json: {}, headers: { 'retry-after': at } }));
    const e1 = (await clientFor(dated.url).check(SIGNED_INPUT, 'k7').catch((e: unknown) => e)) as AuthorityError;
    expect(e1.retryAfterMs).toBeGreaterThan(55_000);
    expect(e1.retryAfterMs).toBeLessThanOrEqual(60_000);
    await dated.close();
    const loose = await startFakeAuthority(() => ({ status: 503, json: {}, headers: { 'retry-after': 'soon 2030' } }));
    const e2 = (await clientFor(loose.url).check(SIGNED_INPUT, 'k8').catch((e: unknown) => e)) as AuthorityError;
    expect(e2.retryAfterMs).toBeNull();
    await loose.close();
  });

  it('HTTP 408 is transient; no Retry-After means no hint', async () => {
    const api = await startFakeAuthority(() => ({ status: 408, json: { error: 'timeout' } }));
    await expect(clientFor(api.url).check(SIGNED_INPUT, 'k4')).rejects.toMatchObject({
      status: 408,
      transient: true,
      retryAfterMs: null,
    });
    await api.close();
  });

  it('a response outside the contract is an AuthorityContractError', async () => {
    const broken = { ...authorityResponse(), receipt_hash: undefined };
    const api = await startFakeAuthority(() => ({ status: 200, json: broken }));
    await expect(clientFor(api.url).check(SIGNED_INPUT, 'k2')).rejects.toBeInstanceOf(AuthorityContractError);
    await api.close();
  });

  it('AuthorityError carries the status; other 4xx are permanent', () => {
    const e = new AuthorityError('x', 400);
    expect(e.status).toBe(400);
    expect(e.transient).toBe(false);
    expect(e.retryAfterMs).toBeNull();
  });
});

describe('authority client refuses authorizations it cannot verify', () => {
  const signed = authorizationRecord(false);
  const { signature_hex: _dropped, ...unsignedRecord } = signed;
  const cases: [string, Record<string, unknown>, unknown][] = [
    ['a bad signature', SIGNED_INPUT, authorityResponse({ authorization: { ...signed, signature_hex: `00${signed.signature_hex.slice(2)}` } })],
    ['a tampered amount', SIGNED_INPUT, authorityResponse({ authorization: { ...signed, fields: { ...signed.fields, amount: '9000000' } } })],
    ['a missing signature', SIGNED_INPUT, authorityResponse({ authorization: unsignedRecord })],
    ['an unknown record field', SIGNED_INPUT, authorityResponse({ authorization: { ...signed, note: 'x' } })],
    ['a record signed by another engine key', SIGNED_INPUT, authorityResponse({ authorization: authorizationRecord(false, {}, OTHER_ENGINE_SECRET_KEY) })],
    ['a record for another action', SIGNED_INPUT, authorityResponse({ authorization: authorizationRecord(false, { actionHash: '0d'.repeat(32) }) })],
    ['a record under another mandate', SIGNED_INPUT, authorityResponse({ authorization: authorizationRecord(false, { mandateHash: '0c'.repeat(32) }) })],
    ['an authorization for a request sent without an agent signature', UNSIGNED_INPUT, authorityResponse()],
    ['an authorization for a plain-English request', TEXT_INPUT, authorityResponse()],
    ['a signed evaluation for a request sent without an agent signature', UNSIGNED_INPUT, authorityResponse({ authorization: null })],
    ['a decision_hash that does not match the evaluation', SIGNED_INPUT, { ...authorityResponse(), decision_hash: '00'.repeat(32) }],
    ['a signed ALLOW without an authorization record', SIGNED_INPUT, authorityResponse({ authorization: null })],
    [
      'a signature-valid record whose verification_ref is a different report',
      SIGNED_INPUT,
      (() => {
        const base = authorityResponse();
        return {
          ...base,
          evaluation: { ...base.evaluation, verification_hash: 'ff'.repeat(32) },
          authorization: authorizationRecord(false, { verificationRef: 'ff'.repeat(32) }),
        };
      })(),
    ],
  ];
  it.each(cases)('%s', async (_label, request, json) => {
    const api = await startFakeAuthority(() => ({ status: 200, json }));
    await expect(clientFor(api.url).check(request as never, 'v1')).rejects.toBeInstanceOf(AuthorityContractError);
    await api.close();
  });
});

describe('buildOutput (the sold result)', () => {
  it('signed ALLOW: decision, checks, verification, authorization intact, receipt link, decision hash', () => {
    const res = authorityResponse({ outcome: 'ALLOW' });
    const { output, resultText } = buildOutput(res as never, `${WEB}/`);
    expect(output).toEqual({
      decision: 'ALLOW',
      summary: output.summary,
      brief: brief('ALLOW'),
      escalation: null,
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

  it('ESCALATE may carry an authorization that requires the principal', () => {
    const { output } = buildOutput(authorityResponse({ outcome: 'ESCALATE' }) as never, WEB);
    expect((output.authorization as { fields: { requires_principal: boolean } }).fields.requires_principal).toBe(true);
  });

  it.each([
    ['authorization for an unsigned proposal (compromised API)', { signed: false, authorization: authorizationRecord(false) }],
    ['authorization for a DENY', { outcome: 'DENY' as const, authorization: authorizationRecord(false) }],
    ['ESCALATE authorization without the principal flag', { outcome: 'ESCALATE' as const, authorization: authorizationRecord(false) }],
    ['authorization for another action', { authorization: authorizationRecord(false, { actionHash: '0d'.repeat(32) }) }],
    ['authorization under another mandate', { authorization: authorizationRecord(false, { mandateHash: '0c'.repeat(32) }) }],
    ['signed ALLOW without an authorization record', { authorization: null }],
  ])('refuses to sell %s', (_label, o) => {
    expect(() => buildOutput(authorityResponse(o) as never, WEB)).toThrow(AuthorityContractError);
  });

  it('refuses a signature-valid record whose verification_ref is a different report', () => {
    const base = authorityResponse();
    const res = {
      ...base,
      evaluation: { ...base.evaluation, verification_hash: 'ff'.repeat(32) },
      authorization: authorizationRecord(false, { verificationRef: 'ff'.repeat(32) }),
    };
    expect(() => buildOutput(res as never, WEB)).toThrow(AuthorityContractError);
  });

  it('with no report, sells a record whose verification_ref matches the evaluation hash', () => {
    const base = authorityResponse();
    const res = { ...base, verification: null, authorization: authorizationRecord(false) };
    expect(buildOutput(res as never, WEB).output.decision).toBe('ALLOW');
    const other = { ...base, verification: null, authorization: authorizationRecord(false, { verificationRef: 'ff'.repeat(32) }) };
    expect(() => buildOutput(other as never, WEB)).toThrow(AuthorityContractError);
  });

  it('check-time ESCALATE with no authorization record stays sellable', () => {
    const res = authorityResponse({ outcome: 'ESCALATE', authorization: null });
    expect(buildOutput(res as never, WEB).output.authorization).toBeNull();
  });
});

describe('the sold result reads as a human authority product', () => {
  const summaryOf = (o: Parameters<typeof authorityResponse>[0]) => buildOutput(authorityResponse(o) as never, WEB).output.summary as string;

  it('ESCALATE: the brief sections, the exact bond price and the endpoint the agent must use', () => {
    const { output } = buildOutput(authorityResponse({ outcome: 'ESCALATE' }) as never, WEB);
    expect(output.brief).toEqual(brief('ESCALATE'));
    expect(output.escalation).toEqual(ESCALATION);
    const s = output.summary as string;
    expect(s).toMatch(/^ESCALATE: 8.42 USDM to AWS \(demo vendor\) for invoice INV-M-0001, requested by cfo-agent-01 under mandate M-001 v3\./);
    expect(s).toContain('Why: Open AWS invoice for October cloud compute.');
    expect(s).toContain(`Verified: invoice facts VERIFIED (Sepolia 0x${'ab'.repeat(32)}); report ${'ee'.repeat(32)}.`);
    expect(s).toContain('Why a human: cfo must sign because autonomous_limit: ABOVE_AUTONOMOUS_LIMIT.');
    expect(s).toContain('What will happen: Release 8.42 USDM from vault acme-treasury');
    expect(s).toContain(`Cost of interrupting: lock a 5 ADA bond at ${PRICE.escrow_address} (approval AP-7, held until 2027-01-15T08:00:00.000Z)`);
    expect(s).toContain(`then POST ${ESCALATION.approval_endpoint} with the x402 PAYMENT-SIGNATURE header. Interrupt budget used 1/3 today.`);
    expect(s).toContain('refunded when the human approves or declines a reasonable ask');
    expect(s).toContain('Only the human signature moves funds.');
  });

  it('ALLOW and DENY: brief rendered, nobody interrupted, no price', () => {
    const allow = summaryOf({ outcome: 'ALLOW' });
    expect(allow).toContain('Why no human: every mandate check passed.');
    expect(allow).toContain('Cost of interrupting: none. Interrupt budget used 1/3 today.');
    const deny = summaryOf({ outcome: 'DENY' });
    expect(deny).toContain('Why denied: RECIPIENT_MISMATCH.');
    expect(deny).toContain('Verified: invoice facts MISMATCH');
    expect(deny).not.toContain('POST ');
  });

  it('a missing brief is tolerated for ALLOW and DENY', () => {
    const allow = buildOutput(authorityResponse({ outcome: 'ALLOW', brief: null }) as never, WEB).output;
    expect(allow.brief).toBeNull();
    expect(allow.summary).toBe('ALLOW: within the mandate. No human is interrupted.');
    const deny = buildOutput(authorityResponse({ outcome: 'DENY', brief: null }) as never, WEB).output;
    expect(deny.summary).toBe('DENY: outside the mandate. No human is interrupted.');
    const noBriefButPriced = buildOutput(authorityResponse({ outcome: 'ESCALATE', brief: null }) as never, WEB).output.summary as string;
    expect(noBriefButPriced).toContain('ESCALATE: a named human must sign.');
    expect(noBriefButPriced).toContain('lock a 5 ADA bond');
  });

  it.each([
    ['ESCALATE without the bond price', { outcome: 'ESCALATE' as const, escalation: null }],
    ['a bond price on an ALLOW', { outcome: 'ALLOW' as const, escalation: ESCALATION }],
    ['a bond price on a DENY', { outcome: 'DENY' as const, escalation: ESCALATION }],
    ['a bond price for another action', { outcome: 'ESCALATE' as const, escalation: { ...ESCALATION, price: { ...PRICE, action_hash: '0d'.repeat(32) } } }],
    ['a brief for another action', { brief: { ...brief('ALLOW'), action_hash: '0d'.repeat(32) } }],
    ['a brief under another mandate', { brief: { ...brief('ALLOW'), mandate: { ...brief('ALLOW').mandate, hash: '0c'.repeat(32) } } }],
    ['a brief that describes another outcome', { outcome: 'ALLOW' as const, brief: brief('DENY') }],
  ])('refuses to sell %s', (_label, o) => {
    expect(() => buildOutput(authorityResponse(o) as never, WEB)).toThrow(AuthorityContractError);
  });

  it.each([
    ['a brief with an unknown field', { brief: { ...brief('ALLOW'), model_note: 'looks fine' } }],
    ['a price with a bad amount', { outcome: 'ESCALATE' as const, escalation: { ...ESCALATION, price: { ...PRICE, amount: '0' } } }],
    ['an endpoint that is not a URL', { outcome: 'ESCALATE' as const, escalation: { ...ESCALATION, approval_endpoint: 'approve here' } }],
  ])('the client rejects %s as off-contract', async (_label, o) => {
    const api = await startFakeAuthority(() => ({ status: 200, json: authorityResponse(o) }));
    await expect(clientFor(api.url).check(SIGNED_INPUT, 'c1')).rejects.toBeInstanceOf(AuthorityContractError);
    await api.close();
  });

  it('the client sells an ESCALATE that carries the price', async () => {
    const api = await startFakeAuthority(() => ({ status: 200, json: authorityResponse({ outcome: 'ESCALATE' }) }));
    const res = await clientFor(api.url).check(SIGNED_INPUT, 'c2');
    expect(res.escalation).toEqual(ESCALATION);
    await api.close();
  });
});
