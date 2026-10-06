import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalHash, decisionHash, REPORT_MAX_AGE_MS, verifyAuthorizationRecord } from '@authority/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allocateNonce } from '../src/authorize';
import { responseDecisionHash } from '../src/check';
import { ADDR, action, type Api, inv, LAB_AGENT_SK, MASUMI_KEY, signed, startApi, usdm } from './harness';

let api: Api;
beforeEach(async () => {
  api = await startApi();
});
afterEach(() => api.close());

const masumi = (proposal: unknown, idem?: string) =>
  api.check({ mandate_id: 'M-001', proposal, execute: false }, { key: MASUMI_KEY, ...(idem ? { idem } : {}) });
const types = (events: Array<{ type: string }>) => events.map((e) => e.type);

describe('authority check: evaluate, verify, evaluate, issue', () => {
  it('signed ALLOW: one authorization bound to the verified report, decision hash and receipt', async () => {
    const a = action({ id: 'A-1', invoice: inv('INV-3821') });
    const res = await masumi(signed(a));
    expect(res.status).toBe(200);
    const b = res.json;
    expect(b.evaluation.outcome).toBe('ALLOW');
    expect(b.authorization.fields.requires_principal).toBe(false);
    expect(b.authorization.fields.verification_ref).toBe(b.verification.report_hash);
    expect(b.authorization.fields.nonce).toBe('1');
    expect(verifyAuthorizationRecord(b.authorization, b.authorization.engine_public_key)).toBe(true);
    expect(b.decision_hash).toBe(decisionHash(canonicalHash(a), b.evaluation.mandate_hash, b.verification.report_hash, 'ALLOW'));
    expect(b.receipt_id).toMatch(/^R-\d{4}$/);
    expect(b.events_url).toBe(`https://api.test/v1/runs/${b.run_id}/events`);
    expect(b.notice).toBeUndefined();
    expect(types(await api.log(b.run_id))).toEqual([
      'RunStarted',
      'ActionProposed',
      'AuthorityEvaluationStarted',
      'AuthorityEvaluated',
      'CREVerificationStarted',
      'CREVerificationCompleted',
      'AuthorityEvaluationStarted',
      'AuthorityEvaluated',
      'AuthorizationIssued',
    ]);
    const receipt = (await api.get(`/v1/receipts/${b.receipt_id}`)).json;
    expect(receipt.receipt_hash).toBe(b.receipt_hash);
    expect(canonicalHash(receipt.receipt)).toBe(b.receipt_hash);
    expect(receipt.receipt.settlement).toBeNull();
    expect(receipt.authorization.digest_hex).toBe(b.authorization.digest_hex);
  });

  it('CRE is triggered with the trigger id the API logged, never one a caller chose', async () => {
    const res = await masumi(signed(action({ id: 'A-1', invoice: inv('INV-3821') })));
    const started = (await api.log(res.json.run_id)).find((e) => e.type === 'CREVerificationStarted')!;
    expect(api.cre.calls).toHaveLength(1);
    expect(api.cre.calls[0]!.triggerId).toBe(started.payload.trigger_id);
  });

  it('execute: false never touches vault state: the same ALLOW asked again stays ALLOW with the same authorization', async () => {
    const proposal = signed(action({ id: 'A-1', invoice: inv('INV-3821') }));
    const first = await masumi(proposal);
    const again = await masumi(proposal);
    const third = await masumi(proposal);
    for (const r of [again, third]) {
      expect(r.status).toBe(200);
      expect(r.json.evaluation.outcome).toBe('ALLOW');
      expect(r.json.authorization.digest_hex).toBe(first.json.authorization.digest_hex);
    }
    // every re-evaluation ran a fresh CRE verification with its own trigger id; none reused a report
    expect(api.cre.calls).toHaveLength(3);
    expect(new Set(api.cre.calls.map((c) => c.triggerId)).size).toBe(3);
    const [counter] = await api.db.query<{ counter: string }>('select counter::text as counter from nonces');
    expect(counter?.counter).toBe('1');
    expect(api.cardano.built).toHaveLength(0);
    expect(api.chains.get(api.b001.vaultHash)!.balance).toBe(BigInt(usdm('135')));
  });

  it('a second issuance for a reserved invoice is a deterministic DENY INVOICE_NOT_OPEN, logged', async () => {
    const first = await masumi(signed(action({ id: 'A-1', invoice: inv('INV-3821') })));
    const other = await masumi(signed(action({ id: 'A-1b', invoice: inv('INV-3821') })));
    expect(other.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INVOICE_NOT_OPEN' });
    expect(other.json.authorization).toBeNull();
    expect(other.json.evaluation.checks.find((c: { id: string }) => c.id === 'invoice_facts')).toMatchObject({
      result: 'fail',
      reason: 'INVOICE_NOT_OPEN',
      detail: { source: 'reservation', authorization_id: 'Z-0001', holder: 'live' },
    });
    expect(other.json.decision_hash).toBe(decisionHash(canonicalHash(action({ id: 'A-1b', invoice: inv('INV-3821') })), first.json.evaluation.mandate_hash, other.json.evaluation.verification_hash, 'DENY'));
    expect((await api.log(other.json.run_id)).at(-1)).toMatchObject({ type: 'ActionDenied', payload: { reason: 'INVOICE_NOT_OPEN', layer: 'engine' } });
  });

  it('concurrent double issuance for one invoice: exactly one wins', async () => {
    const results = await Promise.all(['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => masumi(signed(action({ id: `A-${id}`, invoice: inv('INV-3821') })))));
    expect(results.filter((r) => r.json.authorization !== null)).toHaveLength(1);
    expect(results.filter((r) => r.json.evaluation.reason === 'INVOICE_NOT_OPEN')).toHaveLength(4);
    expect(await api.db.query('select id from authorizations')).toHaveLength(1);
    expect(await api.db.query('select invoice_id from invoice_reservations')).toHaveLength(1);
  });

  it('an expired, unexecuted authorization releases the reservation (logged); the new one uses a fresh report', async () => {
    const first = await masumi(signed(action({ id: 'A-1', invoice: inv('INV-3821') })));
    api.advance(650_000); // expired, but the chain may not show a late settlement yet
    const early = await masumi(signed(action({ id: 'A-1c', invoice: inv('INV-3821') }, api.now())));
    expect(early.status).toBe(429);
    expect(early.headers.get('retry-after')).toBe('120');
    api.advance(80_000); // valid_until + 120 s is now before the chain read
    const later = await masumi(signed(action({ id: 'A-1d', invoice: inv('INV-3821') }, api.now())));
    expect(later.json.authorization.fields.nonce).toBe('2');
    expect(later.json.authorization.fields.verification_ref).toBe(later.json.verification.report_hash);
    expect(later.json.verification.report_hash).not.toBe(first.json.verification.report_hash);
    const released = (await api.log(first.json.run_id)).at(-1)!;
    expect(released).toMatchObject({
      type: 'TransactionRejected',
      action_id: 'A-1',
      payload: { invariant: 'EXPIRED', reservation_released: 'in_3821', tx_body_cbor: null },
    });
    const [old] = await api.db.query<{ status: string }>(`select status from authorizations where action_id = 'A-1'`);
    expect(old!.status).toBe('expired');
  });

  it('an expired authorization that someone executed on-chain keeps the invoice reserved', async () => {
    const first = await masumi(signed(action({ id: 'A-1', invoice: inv('INV-3821') })));
    api.cardano.executeExternally(api.b001.vaultHash, first.json.authorization); // the buyer submitted it themselves
    api.advance(730_000);
    const again = await masumi(signed(action({ id: 'A-1x', invoice: inv('INV-3821') }, api.now())));
    expect(again.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INVOICE_NOT_OPEN' });
    expect(again.json.authorization).toBeNull();
    const [old] = await api.db.query<{ status: string; tx_hash: string }>(`select status, tx_hash from authorizations where action_id = 'A-1'`);
    expect(old).toMatchObject({ status: 'settled', tx_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('REQUIRE_APPROVAL never carries an authorization at check time', async () => {
    const res = await masumi(signed(action({ id: 'A-2', invoice: inv('INV-3822') })));
    expect(res.json.evaluation.outcome).toBe('REQUIRE_APPROVAL');
    expect(res.json.authorization).toBeNull();
    expect(res.json.approval_id).toBeNull(); // pure evaluations never reach the CFO inbox
    expect(await api.db.query('select id from approvals')).toEqual([]);
  });

  it('a report that aged past its window before signing is never signed: a fresh CRE verification runs', async () => {
    const emit = api.eng.log.emit;
    let evaluated = 0;
    api.eng.log.emit = async (input) => {
      const event = await emit(input);
      // The second evaluation consumes the first report; the clock then passes its age limit before the gate signs.
      if (input.type === 'AuthorityEvaluated' && ++evaluated === 2) api.advance(REPORT_MAX_AGE_MS);
      return event;
    };
    const res = await masumi(signed(action({ id: 'A-1', invoice: inv('INV-3821') })));
    expect(res.status).toBe(200);
    expect(api.cre.calls).toHaveLength(2);
    const reports = (await api.log(res.json.run_id)).filter((e) => e.type === 'CREVerificationCompleted').map((e) => e.payload.report_hash);
    expect(reports).toHaveLength(2);
    expect(res.json.verification.report_hash).toBe(reports[1]);
    expect(res.json.authorization.fields.verification_ref).toBe(reports[1]);
    expect(res.json.evaluation.verification_hash).toBe(reports[1]);
  });
});

describe('unsigned input never yields an authorization', () => {
  it('missing signature: full evaluation, marked evaluation only', async () => {
    const res = await masumi({ action: action({ id: 'A-1', invoice: inv('INV-3821') }), agent_signature: null });
    expect(res.json.evaluation).toMatchObject({ outcome: 'ALLOW', signed: false });
    expect(res.json.authorization).toBeNull();
    expect(res.json.notice).toBe('unsigned: evaluation only');
    expect(types(await api.log(res.json.run_id))).not.toContain('AuthorizationIssued');
  });

  it('plain English goes through the interpreter and is evaluated unsigned', async () => {
    await api.close();
    api = await startApi({ interpret: async () => action({ id: 'A-T', invoice: inv('INV-3821') }) });
    const res = await api.check({ mandate_id: 'M-001', request_text: 'Pay AWS invoice INV-3821', execute: false }, { key: MASUMI_KEY });
    expect(res.json.interpreted_action.id).toBe('A-T');
    expect(res.json.evaluation.signed).toBe(false);
    expect(res.json.authorization).toBeNull();
  });

  it('plain English without an interpreter is a permanent 501', async () => {
    const res = await api.check({ mandate_id: 'M-001', request_text: 'Pay AWS', execute: false }, { key: MASUMI_KEY });
    expect(res.status).toBe(501);
  });

  it('a signature by another key is denied', async () => {
    const res = await masumi(signed(action({ id: 'A-1', invoice: inv('INV-3821') }), LAB_AGENT_SK));
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INVALID_AGENT_SIGNATURE' });
  });
});

describe('CRE only for actions the engine has not already denied', () => {
  it.each([
    ['hard cap', { id: 'A-4', invoice: inv('INV-3825') }, 'AMOUNT_ABOVE_HARD_CAP'],
    ['purpose', { id: 'A-5', invoice: null, amount: usdm('2'), type: 'purchase' as const, purpose: 'digital_collectibles', counterparty: ['nft-marketplace', 'NFT marketplace'] as [string, string], recipient: ADDR.nft }, 'PURPOSE_NOT_AUTHORIZED'],
  ])('%s: DENY with zero CRE triggers and zero Stripe reads', async (_l, spec, reason) => {
    const res = await masumi(signed(action(spec)));
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason });
    expect(api.cre.calls).toHaveLength(0);
    expect(api.invoiceReads).toHaveLength(0);
    expect(types(await api.log(res.json.run_id)).at(-1)).toBe('ActionDenied');
  });

  it('treasury floor: DENY with zero CRE triggers', async () => {
    api.chains.get(api.b001.vaultHash)!.balance = BigInt(usdm('108.58'));
    const res = await masumi(signed(action({ id: 'A-7', invoice: inv('INV-3824') })));
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'TREASURY_FLOOR_VIOLATION' });
    expect(api.cre.calls).toHaveLength(0);
  });

  it('attacker recipient (the agent was fooled): CRE stops it, no authorization', async () => {
    const res = await masumi(signed(action({ id: 'A-6', invoice: inv('INV-3823'), recipient: ADDR.attacker })));
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'RECIPIENT_MISMATCH' });
    expect(res.json.authorization).toBeNull();
    const denied = (await api.log(res.json.run_id)).at(-1)!;
    expect(denied).toMatchObject({ type: 'ActionDenied', payload: { reason: 'RECIPIENT_MISMATCH', layer: 'cre' } });
  });
});

describe('invoice number (CRE does not check it, the API does)', () => {
  it('a real invoice id with a fake invoice number is denied INVOICE_NOT_FOUND before any CRE trigger', async () => {
    const res = await masumi(signed(action({ id: 'A-X', invoice: inv('INV-3821'), number: 'INV-9999' })));
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INVOICE_NOT_FOUND' });
    expect(api.cre.calls).toHaveLength(0);
    const log = await api.log(res.json.run_id);
    const evaluated = log.filter((e) => e.type === 'AuthorityEvaluated').at(-1)!;
    expect(evaluated.payload.evaluation.checks.find((c: { id: string }) => c.id === 'invoice_facts')).toMatchObject({
      result: 'fail',
      reason: 'INVOICE_NOT_FOUND',
      detail: { source: 'stripe', invoice_id: 'in_3821', invoice_number: 'INV-9999', on_record: 'INV-3821' },
    });
    expect(log.at(-1)).toMatchObject({ type: 'ActionDenied', payload: { reason: 'INVOICE_NOT_FOUND', layer: 'engine' } });
  });

  it('an unknown invoice id is denied the same way', async () => {
    const fake = { ...inv('INV-3821'), id: 'in_doesnotexist' };
    const res = await masumi(signed(action({ id: 'A-Y', invoice: fake })));
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INVOICE_NOT_FOUND' });
    expect(api.cre.calls).toHaveLength(0);
  });
});

describe('idempotency (retries and duplicates)', () => {
  it('the same key and body returns the stored reply without evaluating again', async () => {
    const proposal = signed(action({ id: 'A-1', invoice: inv('INV-3821') }));
    const a = await masumi(proposal, 'masumi:aabbccddeeff00112233');
    const b = await masumi(proposal, 'masumi:aabbccddeeff00112233');
    expect(b.json).toEqual(a.json);
    expect(api.cre.calls).toHaveLength(1);
    const [n] = await api.db.query<{ n: number }>(`select count(*)::int as n from events where type = 'ActionProposed'`);
    expect(n?.n).toBe(1);
  });

  it('the same key with a different body is a permanent 422', async () => {
    await masumi(signed(action({ id: 'A-1', invoice: inv('INV-3821') })), 'sokosumi:task-1');
    const res = await masumi(signed(action({ id: 'A-2', invoice: inv('INV-3822') })), 'sokosumi:task-1');
    expect(res.status).toBe(422);
  });

  it('a key that is still running answers 429 with Retry-After', async () => {
    const body = { mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') })), execute: false };
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await api.db.query(`insert into idempotency (caller, key, request_hash) values ('masumi', 'smoke:run:allow', $1)`, [requestHash]);
    const res = await api.check(body, { key: MASUMI_KEY, idem: 'smoke:run:allow' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('a dependency outage is a 503 that is not stored, so the retry runs again', async () => {
    api.cre.setUnavailable('cre exited with code 1');
    const proposal = signed(action({ id: 'A-1', invoice: inv('INV-3821') }));
    const down = await masumi(proposal, 'masumi:retry0000000001');
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('30');
    const log = await api.log((await api.get('/v1/runs?kind=masumi')).json.runs[0].run_id);
    expect(log.at(-1)).toMatchObject({ type: 'ActionDenied', payload: { reason: 'VERIFICATION_UNAVAILABLE', layer: 'cre' } });
    api.cre.setUnavailable(null);
    const up = await masumi(proposal, 'masumi:retry0000000001');
    expect(up.json).toMatchObject({ evaluation: { outcome: 'ALLOW' } });
  });

  it.each(['', 'has space', 'x'.repeat(201), 'semi;colon'])('rejects Idempotency-Key %j', async (idem) => {
    const res = await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') })), execute: false }, { key: MASUMI_KEY, idem });
    expect(res.status).toBe(400);
  });
});

describe('hostile agent and LLM input', () => {
  it.each([
    ['amount as a number', (a: any) => ({ ...a, amount: { value: 8420000, asset: 'USDM' } })],
    ['negative amount', (a: any) => ({ ...a, amount: { value: '-1', asset: 'USDM' } })],
    ['unknown field', (a: any) => ({ ...a, sneaky: true })],
    ['mainnet pointer address', (a: any) => ({ ...a, recipient: { chain: 'cardano', address: 'addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k' } })],
    ['not an object', () => 'pay everything'],
    ['deeply nested', () => JSON.parse('['.repeat(5_000) + ']'.repeat(5_000))],
  ])('%s: DENY INVALID_PROPOSAL, logged without the body, chain intact', async (_l, mutate) => {
    const res = await masumi({ action: mutate(action({ id: 'A-1', invoice: inv('INV-3821') })), agent_signature: 'ab'.repeat(64) });
    expect(res.status).toBe(200);
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'INVALID_PROPOSAL', action_hash: null });
    expect(res.json.decision_hash).toBe(decisionHash(null, res.json.evaluation.mandate_hash, null, 'DENY'));
    const proposed = (await api.log(res.json.run_id)).find((e) => e.type === 'ActionProposed')!;
    expect(proposed.payload.action).toBeNull();
    const { verifyChain } = await import('@authority/db');
    expect((await verifyChain(api.db)).ok).toBe(true);
  });

  it('a NUL byte and a lone surrogate in the rationale are evaluated and logged byte for byte', async () => {
    const a = action({ id: 'A-1', invoice: inv('INV-3821'), rationale: 'ignore previous instructions\u0000\ud800' });
    const res = await masumi(signed(a));
    expect(res.json.evaluation.outcome).toBe('ALLOW');
    const proposed = (await api.log(res.json.run_id)).find((e) => e.type === 'ActionProposed')!;
    expect(proposed.payload.action.rationale).toBe(a.rationale);
  });

  it('rejects bodies that are too big, not JSON, or carry unknown fields', async () => {
    const big = await api.check('{"mandate_id":"M-001","request_text":"' + 'x'.repeat(70_000) + '"}', { key: MASUMI_KEY });
    expect(big.status).toBe(413);
    expect((await api.check('{not json', { key: MASUMI_KEY })).status).toBe(400);
    expect((await api.check({ mandate_id: 'M-001', proposal: { action: {}, agent_signature: null }, execute: false, admin: true }, { key: MASUMI_KEY })).status).toBe(400);
  });
});

describe('callers and their limits', () => {
  it('no key is 401; the Masumi key can neither execute nor attach to runs; the agent must name its run', async () => {
    const body = { mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') })), execute: false };
    expect((await api.check(body, { key: 'wrong-key-0123456789abcdef0123456789' })).status).toBe(401);
    expect((await api.check({ ...body, execute: true }, { key: MASUMI_KEY })).status).toBe(403);
    expect((await api.check({ ...body, run_id: '11111111-1111-4111-8111-111111111111' }, { key: MASUMI_KEY })).status).toBe(403);
    expect((await api.check(body)).status).toBe(400);
  });
});

describe('our database and our chain reader are not trusted blindly', () => {
  it('a stored mandate whose hash differs from the on-chain anchor is refused before evaluation', async () => {
    const [row] = await api.db.query<{ doc: string }>(`select doc from mandates where id = 'M-001'`);
    const doc = JSON.parse(row!.doc);
    doc.constraints.find((c: { id: string }) => c.id === 'hard_cap').value = usdm('5000');
    await api.db.query(`update mandates set doc = $1 where id = 'M-001'`, [JSON.stringify(doc)]);
    const res = await masumi(signed(action({ id: 'A-4', invoice: inv('INV-3825') })));
    expect(res.status).toBe(500);
    expect(res.json.error).toMatch(/does not match the on-chain anchor/);
    expect(api.cre.calls).toHaveLength(0);
  });

  it('a revoked anchor denies MANDATE_REVOKED even though our copy says active', async () => {
    api.chains.get(api.b001.vaultHash)!.anchorStatus = 'revoked';
    api.chains.get(api.b001.vaultHash)!.anchorVersion = 4;
    const res = await masumi(signed(action({ id: 'A-1', invoice: inv('INV-3821') })));
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'MANDATE_REVOKED' });
  });

  it('Cardano unavailable is a 503, never an evaluation on stale state', async () => {
    api.cardano.failReads(true);
    const res = await masumi(signed(action({ id: 'A-1', invoice: inv('INV-3821') })));
    expect(res.status).toBe(503);
    expect(api.cre.calls).toHaveLength(0);
  });
});

describe('nonce allocation', () => {
  it('takes max(counter, on-chain last_nonce) + 1 and never goes back', async () => {
    expect(await allocateNonce(api.db, 'v1', 0n)).toBe(1n);
    expect(await allocateNonce(api.db, 'v1', 0n)).toBe(2n);
    expect(await allocateNonce(api.db, 'v1', 7n)).toBe(8n);
    expect(await allocateNonce(api.db, 'v1', 3n)).toBe(9n);
    expect(await allocateNonce(api.db, 'v2', 18_446_744_073_709_551_614n)).toBe(18_446_744_073_709_551_615n);
  });
});

describe('decision hash', () => {
  const vectors: Array<{ name: string; inputs: { action_hash: string | null; mandate_hash: string | null; verification_ref: string | null; outcome: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY' }; decision_hash: string }> =
    JSON.parse(readFileSync(new URL('../../../packages/core/test/vectors/decision.json', import.meta.url), 'utf8'));

  it.each(vectors)('response field maps evaluation fields in vector order: $name', ({ inputs, decision_hash }) => {
    const evaluation = { action_hash: inputs.action_hash, mandate_hash: inputs.mandate_hash as string, verification_hash: inputs.verification_ref, outcome: inputs.outcome };
    if (inputs.mandate_hash === null) expect(() => responseDecisionHash(evaluation)).not.toThrow();
    expect(responseDecisionHash(evaluation)).toBe(decision_hash);
  });
});
