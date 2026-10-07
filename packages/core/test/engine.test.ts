import { describe, expect, it } from 'vitest';
import { REPORT_MAX_AGE_MS, evaluate } from '../src/engine';
import { canonicalHash } from '../src/hash';
import type { Mandate } from '../src/schemas';
import { ATTACKER_ADDR, AWS_ADDR, M001, NOW, action, propose, state, verified } from './fixtures';

const run = (a = action({ id: 'A-1', amount: 8.42 }), opts: { s?: ReturnType<typeof state>; v?: ReturnType<typeof verified> | null; m?: Mandate; sig?: string | null; now?: number } = {}) =>
  evaluate({
    mandate: opts.m ?? M001,
    proposal: { action: a, agent_signature: opts.sig === undefined ? propose(a).agent_signature : opts.sig },
    state: opts.s ?? state(135, 0),
    verification: opts.v === undefined ? verified(a) : opts.v,
    nowMs: opts.now ?? NOW,
  });

describe('evaluate: proposal integrity', () => {
  it('malformed action -> INVALID_PROPOSAL, nothing else evaluated', () => {
    const e = evaluate({ mandate: M001, proposal: { action: { nope: true }, agent_signature: null }, state: state(135, 0), verification: null, nowMs: NOW });
    expect(e).toMatchObject({ outcome: 'DENY', reason: 'INVALID_PROPOSAL', action_hash: null });
    expect(e.checks.slice(1).every((c) => c.result === 'not_evaluated')).toBe(true);
  });

  it('wrong mandate, wrong actor, bad signature', () => {
    expect(run({ ...action({ id: 'A-1', amount: 1 }), mandate_id: 'M-999' }).reason).toBe('WRONG_MANDATE');
    expect(run({ ...action({ id: 'A-1', amount: 1 }), actor: 'intruder' }).reason).toBe('AGENT_NOT_DELEGATE');
    expect(run(action({ id: 'A-1', amount: 1 }), { sig: 'ab'.repeat(64) }).reason).toBe('INVALID_AGENT_SIGNATURE');
  });

  it('unsigned proposal is evaluated but marked unsigned', () => {
    const e = run(action({ id: 'A-1', amount: 8.42 }), { sig: null });
    expect(e.outcome).toBe('ALLOW');
    expect(e.signed).toBe(false);
  });
});

describe('evaluate: mandate validity', () => {
  it.each([
    ['revoked on chain', { s: state(135, 0, { anchor_status: 'revoked' }) }, 'MANDATE_REVOKED'],
    ['version mismatch', { s: state(135, 0, { anchor_version: 4 }) }, 'MANDATE_VERSION_MISMATCH'],
    ['not started', { now: Date.parse('2026-10-05T23:59:59.999Z') }, 'MANDATE_NOT_STARTED'],
    ['expired exactly at expires_at', { now: Date.parse('2026-11-06T00:00:00Z') }, 'MANDATE_EXPIRED'],
  ] as const)('%s', (_label, opts, reason) => {
    expect(run(action({ id: 'A-1', amount: 1 }), opts)).toMatchObject({ outcome: 'DENY', reason });
  });

  it('revoked mandate status', () => {
    expect(run(action({ id: 'A-1', amount: 1 }), { m: { ...M001, status: 'revoked' } })).toMatchObject({ outcome: 'DENY', reason: 'MANDATE_REVOKED' });
  });

  it('throws when nowMs is not a safe integer', () => {
    expect(() => run(action({ id: 'A-1', amount: 1 }), { now: Number.NaN })).toThrow(TypeError);
  });
});

describe('evaluate: state validation', () => {
  // 45 already spent + 9 is over the 50 cap; a malformed state must not reset or widen it.
  it.each([
    ['spent_today empty', state(135, 45, { spent_today: '' })],
    ['spent_today negative', state(135, 45, { spent_today: '-41000000' })],
    ['spent_today -1', state(135, 45, { spent_today: '-1' })],
    ['vault_balance hex', state(135, 0, { vault_balance: '0x8000000' })],
    ['last_nonce hex', state(135, 0, { last_nonce: '0x1' })],
  ])('%s throws instead of evaluating', (_label, s) => {
    expect(() => run(action({ id: 'A-1', amount: 9 }), { s })).toThrow();
  });
});

describe('evaluate: algorithm', () => {
  it('short-circuits on the first DENY', () => {
    const e = run(action({ id: 'A-5', amount: 2, type: 'purchase', purpose: 'digital_collectibles', counterparty: 'nft-marketplace', invoice: null }), { v: null });
    expect(e).toMatchObject({ outcome: 'DENY', reason: 'PURPOSE_NOT_AUTHORIZED' });
    expect(e.checks.filter((c) => c.result === 'fail')).toHaveLength(1);
    expect(e.checks.find((c) => c.id === 'action')?.result).toBe('not_evaluated');
  });

  it('accumulates approvals and DENY still overrides', () => {
    const e = run(action({ id: 'A-x', amount: 60 }), { v: null });
    expect(e).toMatchObject({ outcome: 'DENY', reason: 'AMOUNT_ABOVE_HARD_CAP' });
    expect(e.approvals_required.map((a) => a.reason)).toEqual(['ABOVE_AUTONOMOUS_LIMIT']);
  });

  it('pauses for verification only after every earlier constraint passed', () => {
    const a = action({ id: 'A-1', amount: 8.42 });
    const e = run(a, { v: null });
    expect(e.outcome).toBe('NEEDS_VERIFICATION');
    expect(e.checks.find((c) => c.id === 'invoice_facts')?.result).toBe('pending');
  });

  it('never asks for verification when a DENY already fired', () => {
    const e = run(action({ id: 'A-7', amount: 9 }), { s: state(108.58, 26.42), v: null });
    expect(e).toMatchObject({ outcome: 'DENY', reason: 'TREASURY_FLOOR_VIOLATION' });
  });

  it('records the verification hash it used', () => {
    const a = action({ id: 'A-1', amount: 8.42 });
    const v = verified(a);
    expect(run(a, { v }).verification_hash).toBe(v.report_hash);
  });

  it('above the autonomous limit with a verified report needs approval', () => {
    const e = run(action({ id: 'A-2', amount: 18 }));
    expect(e).toMatchObject({ outcome: 'ESCALATE', reason: null });
    expect(e.approvals_required.map((r) => r.reason)).toEqual(['ABOVE_AUTONOMOUS_LIMIT']);
  });

  it('a MISMATCH report denies with its reason', () => {
    const a = action({ id: 'A-1', amount: 8.42 });
    expect(run(a, { v: verified(a, 'MISMATCH', 'RECIPIENT_MISMATCH') })).toMatchObject({ outcome: 'DENY', reason: 'RECIPIENT_MISMATCH' });
  });

  it('a VERIFIED report with a false fact denies with that fact', () => {
    const a = action({ id: 'A-1', amount: 8.42 });
    const v = verified(a);
    const report = { ...v.report, facts: { ...v.report.facts, amount_match: false } };
    expect(run(a, { v: { ...v, report, report_hash: canonicalHash(report) } })).toMatchObject({ outcome: 'DENY', reason: 'AMOUNT_MISMATCH' });
  });

  it('a VERIFIED report naming a different recipient than the action denies with RECIPIENT_MISMATCH', () => {
    const a = action({ id: 'A-1', amount: 8.42, recipient: ATTACKER_ADDR });
    expect(run(a).outcome).toBe('ALLOW');
    const v = verified(a);
    const report = { ...v.report, verified_recipient: AWS_ADDR };
    const e = run(a, { v: { ...v, report, report_hash: canonicalHash(report) } });
    expect(e).toMatchObject({ outcome: 'DENY', reason: 'RECIPIENT_MISMATCH' });
    expect(e.checks.filter((c) => c.result === 'fail').map((c) => [c.id, c.reason])).toEqual([['invoice_facts', 'RECIPIENT_MISMATCH']]);
  });
});

describe('evaluate: report usability', () => {
  const a = action({ id: 'A-1', amount: 8.42 });

  it('accepts a report exactly REPORT_MAX_AGE_MS old and rejects 1 ms older', () => {
    expect(run(a, { v: verified(a, 'VERIFIED', undefined, NOW - REPORT_MAX_AGE_MS) }).outcome).toBe('ALLOW');
    expect(run(a, { v: verified(a, 'VERIFIED', undefined, NOW - REPORT_MAX_AGE_MS - 1) }).outcome).toBe('NEEDS_VERIFICATION');
  });

  it('ignores a report for another action', () => {
    const other = action({ id: 'A-2', amount: 8.42 });
    expect(run(a, { v: verified(other) }).outcome).toBe('NEEDS_VERIFICATION');
  });

  it('ignores a report whose hash does not match its content', () => {
    const v = verified(a);
    expect(run(a, { v: { ...v, report_hash: canonicalHash({ tampered: true }) } }).outcome).toBe('NEEDS_VERIFICATION');
  });

  it('ignores a report from too far in the future', () => {
    expect(run(a, { v: verified(a, 'VERIFIED', undefined, NOW + 60_001) }).outcome).toBe('NEEDS_VERIFICATION');
  });

  it('accepts a report exactly 60,000 ms in the future', () => {
    expect(run(a, { v: verified(a, 'VERIFIED', undefined, NOW + 60_000) }).outcome).toBe('ALLOW');
  });

  it('ignores a report whose block time is NaN', () => {
    expect(run(a, { v: { ...verified(a), block_time_ms: Number.NaN } }).outcome).toBe('NEEDS_VERIFICATION');
  });
});
