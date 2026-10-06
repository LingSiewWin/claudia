import { describe, expect, it } from 'vitest';
import { verifyAuthorizationRecord } from '../src/authorization';
import { type Evaluation, evaluate } from '../src/engine';
import { canonicalHash } from '../src/hash';
import * as core from '../src/index';
import { AUTHORIZATION_TTL_MS, type IssueInput, IssuanceRefused, issueAuthorization } from '../src/issue';
import type { ActionIR, Mandate } from '../src/schemas';
import { ATTACKER_ADDR, CHAIN, ENGINE_PK, ENGINE_SK, GLOBEX_ADDR, M001, NOW, action, propose, state, verified } from './fixtures';

function prepared(a: ActionIR, opts: { signed?: boolean; now?: number; mandate?: Mandate } = {}): IssueInput {
  const now = opts.now ?? NOW;
  return {
    mandate: opts.mandate ?? M001,
    proposal: { action: a, agent_signature: opts.signed === false ? null : propose(a).agent_signature },
    state: state(135, 0),
    verification: verified(a, 'VERIFIED', undefined, now - 30_000),
    nowMs: now,
    approval: null,
    chain: CHAIN,
    nonce: 1n,
    engineSecretKey: ENGINE_SK,
  };
}

const cfo = (a: ActionIR, at = NOW) => ({ approver: 'CFO', action_hash: canonicalHash(a), approved_at_ms: at });

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
    expect(record.fields.verification_ref).toBe(input.verification?.report_hash);
    expect(record.fields.amount).toBe('8420000');
  });

  it('refuses unsigned proposals', () => {
    expect(refusal(prepared(action({ id: 'A-1', amount: 8.42 }), { signed: false }))).toBe('UNSIGNED_PROPOSAL');
  });

  it('REQUIRE_APPROVAL needs a matching approval, then sets requires_principal', () => {
    const a = action({ id: 'A-2', amount: 18 });
    const input = prepared(a);
    expect(refusal(input)).toBe('APPROVAL_MISSING');
    expect(refusal({ ...input, approval: { ...cfo(a), approver: 'CEO' } })).toBe('APPROVAL_MISSING');
    const record = issueAuthorization({ ...input, approval: cfo(a) });
    expect(record.fields.requires_principal).toBe(true);
  });

  it('a counterparty-only approval below the autonomous limit still sets requires_principal', () => {
    const a = action({ id: 'A-G0042', amount: 5, counterparty: 'globex', display: 'Globex (demo vendor)', recipient: GLOBEX_ADDR, invoice: 'INV-G-0042' });
    const input = prepared(a);
    expect(evaluate(input).approvals_required.map((x) => x.reason)).toEqual(['COUNTERPARTY_NOT_APPROVED']);
    expect(issueAuthorization({ ...input, approval: cfo(a) }).fields.requires_principal).toBe(true);
  });

  it('refuses DENY and NEEDS_VERIFICATION', () => {
    const big = action({ id: 'A-4', amount: 60 });
    expect(refusal({ ...prepared(big), approval: cfo(big) })).toBe('NOT_AUTHORIZABLE');
    expect(refusal({ ...prepared(action({ id: 'A-1', amount: 8.42 })), verification: null })).toBe('NOT_AUTHORIZABLE');
  });

  it('measures report freshness at signing time', () => {
    const input = { ...prepared(action({ id: 'A-1', amount: 8.42 })), verification: verified(action({ id: 'A-1', amount: 8.42 }), 'VERIFIED', undefined, NOW - 600_000) };
    expect(verifyAuthorizationRecord(issueAuthorization(input), ENGINE_PK)).toBe(true);
    // The same report is 660 s old when signing happens 60 s later: re-verify, never sign.
    expect(refusal({ ...input, nowMs: NOW + 60_000 })).toBe('NOT_AUTHORIZABLE');
  });

  it('caps valid_until at now + TTL and at mandate expiry', () => {
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

  it('refuses a nonce at or below the chain last_nonce, and one above u64 max', () => {
    const input = { ...prepared(action({ id: 'A-1', amount: 8.42 })), state: state(135, 0, { last_nonce: '5' }) };
    expect(refusal({ ...input, nonce: 3n })).toBe('INVALID_NONCE');
    expect(refusal({ ...input, nonce: 5n })).toBe('INVALID_NONCE');
    expect(issueAuthorization({ ...input, nonce: 6n }).fields.nonce).toBe('6');
    expect(refusal({ ...input, nonce: 1n << 64n })).toBe('INVALID_NONCE');
    expect(issueAuthorization({ ...input, nonce: (1n << 64n) - 1n }).fields.nonce).toBe('18446744073709551615');
  });

  it('throws on a non-integer nowMs or malformed state', () => {
    const input = prepared(action({ id: 'A-1', amount: 8.42 }));
    expect(() => issueAuthorization({ ...input, nowMs: Number.NaN })).toThrow(TypeError);
    expect(() => issueAuthorization({ ...input, nowMs: Number.NaN })).toThrow(/nowMs must be a safe integer/);
    expect(() => issueAuthorization({ ...input, state: state(135, 45, { spent_today: '' }) })).toThrow();
  });
});

describe('issueAuthorization (no Evaluation input)', () => {
  // Compile-time: IssueInput has no `evaluation` field, so a caller cannot hand the gate a verdict.
  type TakesEvaluation = 'evaluation' extends keyof IssueInput ? true : false;
  const takesEvaluation: TakesEvaluation = false;

  it('ignores a forged { outcome: ALLOW, signed: true } and evaluates the real inputs', () => {
    expect(takesEvaluation).toBe(false);
    const a = action({ id: 'A-X', amount: 9.99, purpose: 'anything', counterparty: 'nobody', recipient: ATTACKER_ADDR, invoice: null });
    const honest = evaluate({ mandate: M001, proposal: propose(a), state: state(135, 0), verification: null, nowMs: NOW });
    const forged: Evaluation = { ...honest, outcome: 'ALLOW', reason: null, signed: true };
    const smuggled = { ...prepared(a), verification: null, evaluation: forged, action: a } as IssueInput;
    expect(refusal(smuggled)).toBe('NOT_AUTHORIZABLE');
    const unsigned = { ...prepared(a, { signed: false }), evaluation: forged, action: a } as IssueInput;
    expect(refusal(unsigned)).toBe('UNSIGNED_PROPOSAL');
  });
});

describe('issueAuthorization (refusals that remain)', () => {
  const without = (id: string): Mandate => ({ ...M001, constraints: M001.constraints.filter((c) => c.id !== id) });
  const allowsTransfer: Mandate = {
    ...M001,
    constraints: M001.constraints.map((c) => (c.kind === 'action_in' ? { ...c, values: ['pay_invoice', 'transfer'] } : c)),
  };
  const small = action({ id: 'A-1', amount: 8.42 });
  const needsCfo = action({ id: 'A-2', amount: 18 });
  const ada: ActionIR = { ...small, amount: { ...small.amount, asset: 'ADA' } };

  const cases: [string, IssueInput, string][] = [
    ['mandate without a hard cap', prepared(small, { mandate: without('hard_cap') }), 'ABOVE_HARD_CAP'],
    ['mandate without an autonomous limit', prepared(small, { mandate: without('autonomous') }), 'NOT_AUTHORIZABLE'],
    ['action asset differs from the mandate asset', prepared(ada, { mandate: without('asset') }), 'ASSET_MISMATCH'],
    ['action type other than pay_invoice', prepared(action({ id: 'A-1', amount: 8.42, type: 'transfer' }), { mandate: allowsTransfer }), 'UNSUPPORTED_ACTION_TYPE'],
    ['approval in the future', { ...prepared(needsCfo), approval: cfo(needsCfo, NOW + 1) }, 'APPROVAL_MISSING'],
    ['approval older than 60s', { ...prepared(needsCfo), approval: cfo(needsCfo, NOW - 60_001) }, 'APPROVAL_MISSING'],
    ['approval with NaN time', { ...prepared(needsCfo), approval: cfo(needsCfo, Number.NaN) }, 'APPROVAL_MISSING'],
    ['approval for another action', { ...prepared(needsCfo), approval: cfo(action({ id: 'A-3', amount: 18 })) }, 'APPROVAL_MISSING'],
    ['approval without an action hash', { ...prepared(needsCfo), approval: { approver: 'CFO', approved_at_ms: NOW } as IssueInput['approval'] }, 'APPROVAL_MISSING'],
  ];

  it.each(cases)('refuses %s', (_, input, code) => {
    expect(refusal(input)).toBe(code);
  });

  it('accepts an approval exactly 60s old', () => {
    const record = issueAuthorization({ ...prepared(needsCfo), approval: cfo(needsCfo, NOW - 60_000) });
    expect(record.fields.requires_principal).toBe(true);
  });

  it('exports the gate as the only signing path', () => {
    expect('signAuthorization' in core).toBe(false);
    expect(typeof core.issueAuthorization).toBe('function');
    expect(typeof core.verifyAuthorizationRecord).toBe('function');
  });
});
