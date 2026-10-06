import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical';
import { type Evaluation, evaluate } from '../src/engine';
import { IssuanceRefused, issueAuthorization } from '../src/issue';
import type { ActionType, Mandate } from '../src/schemas';
import { ATTACKER_ADDR, AWS_ADDR, CHAIN, ENGINE_SK, M001, NOW, action, propose, state, verified } from './fixtures';

const HARD_CAP = 50_000_000n;
const RANK: Record<Evaluation['outcome'], number> = { ALLOW: 0, REQUIRE_APPROVAL: 1, DENY: 2, NEEDS_VERIFICATION: -1 };

const scenario = fc.record({
  amountCents: fc.integer({ min: 1, max: 20_000 }),
  balance: fc.integer({ min: 0, max: 300 }),
  spent: fc.integer({ min: 0, max: 80 }),
  purpose: fc.constantFrom('invoice_payment', 'digital_collectibles'),
  type: fc.constantFrom<ActionType>('pay_invoice', 'purchase', 'transfer'),
  counterparty: fc.constantFrom('aws', 'stripe', 'globex'),
  recipient: fc.constantFrom(AWS_ADDR, ATTACKER_ADDR),
  verification: fc.constantFrom('verified', 'mismatch', 'none'),
  signature: fc.constantFrom('valid', 'invalid', 'absent'),
  anchorStatus: fc.constantFrom<'active' | 'revoked'>('active', 'active', 'active', 'revoked'),
  anchorVersion: fc.constantFrom(3, 3, 3, 2),
  rationale: fc.string({ maxLength: 200 }),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

function build(s: Scenario, mandate: Mandate = M001) {
  const a = action({
    id: 'A-P',
    amount: s.amountCents / 100,
    purpose: s.purpose,
    type: s.type,
    counterparty: s.counterparty,
    recipient: s.recipient,
    rationale: s.rationale,
  });
  const signed = propose(a);
  const agent_signature = s.signature === 'valid' ? signed.agent_signature : s.signature === 'invalid' ? 'ab'.repeat(64) : null;
  const verification = s.verification === 'none' ? null : verified(a, s.verification === 'verified' ? 'VERIFIED' : 'MISMATCH', 'RECIPIENT_MISMATCH');
  return {
    a,
    input: {
      mandate,
      proposal: { action: a, agent_signature },
      state: state(s.balance, s.spent, { anchor_status: s.anchorStatus, anchor_version: s.anchorVersion }),
      verification,
      nowMs: NOW,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('engine invariants', () => {
  it('above the hard cap the outcome is DENY and issuance refuses', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const { a, input } = build(s);
        if (BigInt(a.amount.value) <= HARD_CAP) return;
        const e = evaluate(input);
        expect(e.outcome).toBe('DENY');
        expect(() =>
          issueAuthorization({ evaluation: e, action: a, mandate: M001, approval: { approver: 'CFO', approved_at_ms: NOW }, chain: CHAIN, nonce: 1n, nowMs: NOW, engineSecretKey: ENGINE_SK }),
        ).toThrow(IssuanceRefused);
      }),
    );
  });

  it('evaluate never mutates its inputs', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const { input } = build(s);
        const before = canonicalJson(input);
        evaluate(deepFreeze(input));
        expect(canonicalJson(input)).toBe(before);
      }),
    );
  });

  it('revoked or version-mismatched mandate never yields ALLOW or REQUIRE_APPROVAL', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        if (s.anchorStatus === 'active' && s.anchorVersion === 3) return;
        expect(evaluate(build(s).input).outcome).toBe('DENY');
      }),
    );
  });

  it('deterministic, byte-identical output', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const { input } = build(s);
        expect(canonicalJson(evaluate(structuredClone(input)))).toBe(canonicalJson(evaluate(structuredClone(input))));
      }),
    );
  });

  it('every DENY has exactly one reason and one failed check', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const e = evaluate(build(s).input);
        if (e.outcome !== 'DENY') return;
        expect(e.reason).not.toBeNull();
        expect(e.checks.filter((c) => c.result === 'fail')).toHaveLength(1);
      }),
    );
  });

  it('removing a constraint never makes the outcome stricter', () => {
    fc.assert(
      fc.property(scenario, fc.integer({ min: 0, max: M001.constraints.length - 1 }), (s, drop) => {
        const withReport = { ...s, verification: s.verification === 'none' ? 'verified' : s.verification };
        const full = evaluate(build(withReport).input);
        const reduced: Mandate = { ...M001, constraints: M001.constraints.filter((_, i) => i !== drop) };
        const sub = evaluate(build(withReport, reduced).input);
        expect(RANK[sub.outcome]).toBeLessThanOrEqual(RANK[full.outcome]);
      }),
    );
  });

  it('the rationale never changes outcome or reason', () => {
    fc.assert(
      fc.property(scenario, fc.string({ maxLength: 500 }), (s, other) => {
        const one = evaluate(build(s).input);
        const two = evaluate(build({ ...s, rationale: other }).input);
        expect([two.outcome, two.reason]).toEqual([one.outcome, one.reason]);
      }),
    );
  });
});
