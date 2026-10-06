import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical';
import { type Evaluation, evaluate } from '../src/engine';
import { IssuanceRefused, issueAuthorization } from '../src/issue';
import type { ActionType, Mandate } from '../src/schemas';
import { ATTACKER_ADDR, AWS_ADDR, CHAIN, ENGINE_SK, M001, NOW, action, propose, state, verified } from './fixtures';

const HARD_CAP = 50_000_000n;
const RANK: Record<Evaluation['outcome'], number> = { ALLOW: 0, REQUIRE_APPROVAL: 1, DENY: 2, NEEDS_VERIFICATION: -1 };

const broad = fc.record({
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
type Scenario = typeof broad extends fc.Arbitrary<infer T> ? T : never;

// Constructed so the action is usually authorizable: only the anchor check stands in the way (an absent signature does not change evaluate(); it only blocks issuance). Globex draws the counterparty approval path.
const nearly: fc.Arbitrary<Scenario> = fc
  .integer({ min: 0, max: 49 })
  .chain((spent) =>
    fc.integer({ min: 1, max: Math.min(5000, (50 - spent) * 100) }).chain((amountCents) =>
      fc.record({
        amountCents: fc.constant(amountCents),
        balance: fc.integer({ min: 101 + Math.floor(amountCents / 100), max: 300 }),
        spent: fc.constant(spent),
        purpose: fc.constant('invoice_payment'),
        type: fc.constant<ActionType>('pay_invoice'),
        counterparty: fc.constantFrom('aws', 'stripe', 'globex'),
        recipient: fc.constant(AWS_ADDR),
        verification: fc.constant<'verified' | 'mismatch' | 'none'>('verified'),
        signature: fc.constantFrom<'valid' | 'invalid' | 'absent'>('valid', 'absent'),
        anchorStatus: fc.constantFrom<'active' | 'revoked'>('active', 'active', 'active', 'revoked'),
        anchorVersion: fc.constantFrom(3, 3, 3, 2),
        rationale: fc.string({ maxLength: 200 }),
      }),
    ),
  );

const scenario = fc.oneof(broad, nearly);

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
        const forged: Evaluation = {
          ...e,
          outcome: 'REQUIRE_APPROVAL',
          signed: true,
          reason: null,
          approvals_required: [{ constraint: 'autonomous', approver: 'CFO', reason: 'ABOVE_AUTONOMOUS_LIMIT' }],
        };
        let code: unknown;
        try {
          issueAuthorization({ evaluation: forged, action: a, mandate: M001, approval: { approver: 'CFO', approved_at_ms: NOW }, chain: CHAIN, nonce: 1n, nowMs: NOW, engineSecretKey: ENGINE_SK });
        } catch (err) {
          code = err instanceof IssuanceRefused ? err.code : err;
        }
        expect(code).toBe('ABOVE_HARD_CAP');
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
    const stale = fc.oneof(
      fc.record({ anchorStatus: fc.constant<'active' | 'revoked'>('revoked'), anchorVersion: fc.constantFrom(3, 2) }),
      fc.record({ anchorStatus: fc.constant<'active' | 'revoked'>('active'), anchorVersion: fc.constant(2) }),
    );
    fc.assert(
      fc.property(nearly, stale, (n, anchor) => {
        expect(evaluate(build({ ...n, ...anchor }).input).outcome).toBe('DENY');
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
        const failed = e.checks.filter((c) => c.result === 'fail');
        expect(failed).toHaveLength(1);
        expect(e.reason).toBe(failed[0]?.reason);
      }),
    );
  });

  it('removing a constraint never makes the outcome stricter', () => {
    fc.assert(
      fc.property(nearly, (s) => {
        const full = evaluate(build(s).input);
        expect(full.outcome).not.toBe('NEEDS_VERIFICATION');
        for (const drop of M001.constraints.keys()) {
          const reduced: Mandate = { ...M001, constraints: M001.constraints.filter((_, i) => i !== drop) };
          const sub = evaluate(build(s, reduced).input);
          expect(sub.outcome).not.toBe('NEEDS_VERIFICATION');
          expect(RANK[sub.outcome]).toBeLessThanOrEqual(RANK[full.outcome]);
        }
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
