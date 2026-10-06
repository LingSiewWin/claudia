import { describe, expect, it } from 'vitest';
import { verifyAuthorizationRecord } from '../src/authorization';
import { evaluate } from '../src/engine';
import { AUTHORIZATION_TTL_MS, type IssueInput, IssuanceRefused, issueAuthorization } from '../src/issue';
import type { ActionIR } from '../src/schemas';
import { CHAIN, ENGINE_PK, ENGINE_SK, M001, NOW, action, propose, state, verified } from './fixtures';

function prepared(a: ActionIR, opts: { signed?: boolean; balance?: number; now?: number } = {}): IssueInput {
  const evaluation = evaluate({
    mandate: M001,
    proposal: { action: a, agent_signature: opts.signed === false ? null : propose(a).agent_signature },
    state: state(opts.balance ?? 135, 0),
    verification: verified(a, 'VERIFIED', undefined, (opts.now ?? NOW) - 30_000),
    nowMs: opts.now ?? NOW,
  });
  return { evaluation, action: a, mandate: M001, approval: null, chain: CHAIN, nonce: 1n, nowMs: opts.now ?? NOW, engineSecretKey: ENGINE_SK };
}

const refusal = (input: IssueInput) => {
  try {
    issueAuthorization(input);
    return null;
  } catch (e) {
    return e instanceof IssuanceRefused ? e.code : String(e);
  }
};

describe('issueAuthorization (gate)', () => {
  it('signs an ALLOW with requires_principal false and verification ref', () => {
    const input = prepared(action({ id: 'A-1', amount: 8.42 }));
    const record = issueAuthorization(input);
    expect(verifyAuthorizationRecord(record, ENGINE_PK)).toBe(true);
    expect(record.fields.requires_principal).toBe(false);
    expect(record.fields.verification_ref).toBe(input.evaluation.verification_hash);
    expect(record.fields.amount).toBe('8420000');
  });

  it('refuses unsigned proposals (E4)', () => {
    expect(refusal(prepared(action({ id: 'A-1', amount: 8.42 }), { signed: false }))).toBe('UNSIGNED_PROPOSAL');
  });

  it('REQUIRE_APPROVAL needs a matching approval, then sets requires_principal', () => {
    const input = prepared(action({ id: 'A-2', amount: 18 }));
    expect(input.evaluation.outcome).toBe('REQUIRE_APPROVAL');
    expect(refusal(input)).toBe('APPROVAL_MISSING');
    expect(refusal({ ...input, approval: { approver: 'CEO', approved_at_ms: NOW } })).toBe('APPROVAL_MISSING');
    const record = issueAuthorization({ ...input, approval: { approver: 'CFO', approved_at_ms: NOW } });
    expect(record.fields.requires_principal).toBe(true);
  });

  it('refuses DENY and NEEDS_VERIFICATION', () => {
    const denied = prepared(action({ id: 'A-4', amount: 60 }));
    expect(refusal(denied)).toBe('NOT_AUTHORIZABLE');
    const a = action({ id: 'A-1', amount: 8.42 });
    const pending = { ...prepared(a), evaluation: evaluate({ mandate: M001, proposal: propose(a), state: state(135, 0), verification: null, nowMs: NOW }) };
    expect(refusal(pending)).toBe('NOT_AUTHORIZABLE');
  });

  it('refuses stale evaluations and tampered actions', () => {
    const input = prepared(action({ id: 'A-1', amount: 8.42 }));
    expect(refusal({ ...input, nowMs: NOW + 60_001 })).toBe('STALE_EVALUATION');
    expect(refusal({ ...input, action: { ...input.action, amount: { value: '84200000', asset: 'USDM' } } })).toBe('ACTION_MISMATCH');
  });

  it('caps valid_until at now + TTL and at mandate expiry (Review Focus 2)', () => {
    const normal = issueAuthorization(prepared(action({ id: 'A-1', amount: 8.42 })));
    expect(normal.fields.valid_until).toBe(NOW + AUTHORIZATION_TTL_MS);
    const nearExpiry = Date.parse('2026-11-06T00:00:00Z') - 1;
    const late = issueAuthorization(prepared(action({ id: 'A-1', amount: 8.42 }), { now: nearExpiry }));
    expect(late.fields.valid_until).toBe(Date.parse('2026-11-06T00:00:00Z'));
  });

  it('refuses nonce 0, wrong asset binding, and an unencodable recipient', () => {
    const input = prepared(action({ id: 'A-1', amount: 8.42 }));
    expect(refusal({ ...input, nonce: 0n })).toBe('INVALID_NONCE');
    expect(refusal({ ...input, chain: { ...CHAIN, assetSymbol: 'ADA' } })).toBe('ASSET_MISMATCH');
    expect(refusal({ ...input, chain: { ...CHAIN, chainTag: 1 } })).toBe('RECIPIENT_UNENCODABLE');
  });

  it('throws on a non-integer nowMs', () => {
    const input = prepared(action({ id: 'A-1', amount: 8.42 }));
    expect(() => issueAuthorization({ ...input, nowMs: Number.NaN })).toThrow(TypeError);
    expect(() => issueAuthorization({ ...input, nowMs: Number.NaN })).toThrow(/nowMs must be a safe integer/);
    expect(refusal({ ...input, evaluation: { ...input.evaluation, evaluated_at_ms: Number.NaN } })).toBe('STALE_EVALUATION');
  });
});
