import { describe, expect, it } from 'vitest';
import { ActionIRSchema, MandateSchema, VerificationReportSchema } from '../src/schemas';
import { AWS_ADDR, M001_INPUT, action, verificationReport } from './fixtures';

describe('ActionIRSchema', () => {
  const good = action({ id: 'A-1', amount: 8.42 });

  it('accepts a well-formed action', () => {
    expect(ActionIRSchema.safeParse(good).success).toBe(true);
  });

  it.each([
    ['unknown field', { ...good, extra: 1 }],
    ['amount as number', { ...good, amount: { value: 8420, asset: 'USDM' } }],
    ['negative amount', { ...good, amount: { value: '-1', asset: 'USDM' } }],
    ['fractional amount', { ...good, amount: { value: '1.5', asset: 'USDM' } }],
    ['zero amount', { ...good, amount: { value: '0', asset: 'USDM' } }],
    ['leading zero', { ...good, amount: { value: '01', asset: 'USDM' } }],
    ['amount >= 2^64', { ...good, amount: { value: (1n << 64n).toString(), asset: 'USDM' } }],
    ['unknown action type', { ...good, type: 'withdraw_all' }],
    ['pointer or garbage address', { ...good, recipient: { chain: 'cardano', address: 'addr_test1xyz' } }],
    ['non-cardano chain', { ...good, recipient: { chain: 'solana', address: AWS_ADDR } }],
    ['datetime with offset', { ...good, created_at: '2026-10-07T03:00:00+08:00' }],
    ['rationale too long', { ...good, rationale: 'x'.repeat(2001) }],
  ])('rejects %s', (_label, value) => {
    expect(ActionIRSchema.safeParse(value).success).toBe(false);
  });
});

describe('MandateSchema', () => {
  it('accepts M-001', () => {
    expect(MandateSchema.safeParse(M001_INPUT).success).toBe(true);
  });

  it('rejects delegation allowed', () => {
    expect(MandateSchema.safeParse({ ...M001_INPUT, delegation: { allowed: true } }).success).toBe(false);
  });

  it('rejects an unknown constraint kind', () => {
    const bad = { ...M001_INPUT, constraints: [{ id: 'x', kind: 'time_of_day', on_violation: 'DENY' }] };
    expect(MandateSchema.safeParse(bad).success).toBe(false);
  });
});

describe('VerificationReportSchema', () => {
  it('requires reason null exactly when VERIFIED', () => {
    const ok = verificationReport(action({ id: 'A-1', amount: 1 }), 'VERIFIED');
    expect(VerificationReportSchema.safeParse(ok).success).toBe(true);
    expect(VerificationReportSchema.safeParse({ ...ok, reason: 'RECIPIENT_MISMATCH' }).success).toBe(false);
    expect(VerificationReportSchema.safeParse({ ...ok, result: 'MISMATCH' }).success).toBe(false);
  });
});
