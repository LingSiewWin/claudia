import { describe, expect, it } from 'vitest';
import { checkConstraint, type ConstraintContext } from '../src/constraints';
import type { Constraint } from '../src/schemas';
import { M001, NOW, action, state, usdm, verified } from './fixtures';

const c = (id: string) => M001.constraints.find((x) => x.id === id) as Constraint;
const ctx = (amount: number, balance = 135, spent = 0, overrides: Partial<ConstraintContext> = {}): ConstraintContext => {
  const a = action({ id: 'A-1', amount });
  return { action: a, amount: BigInt(usdm(amount)), state: state(balance, spent), dayIndex: Math.floor(NOW / 86_400_000), verification: null, ...overrides };
};

describe('checkConstraint', () => {
  it('purpose_in', () => {
    expect(checkConstraint(c('purpose'), ctx(1)).violated).toBe(false);
    const bad = { ...ctx(1), action: action({ id: 'A-2', amount: 1, purpose: 'digital_collectibles' }) };
    expect(checkConstraint(c('purpose'), bad)).toMatchObject({ violated: true, reason: 'PURPOSE_NOT_AUTHORIZED' });
  });

  it('action_in', () => {
    const bad = { ...ctx(1), action: action({ id: 'A-2', amount: 1, type: 'purchase' }) };
    expect(checkConstraint(c('action'), bad)).toMatchObject({ violated: true, reason: 'ACTION_NOT_AUTHORIZED' });
  });

  it('counterparty_in maps to COUNTERPARTY_NOT_APPROVED', () => {
    const bad = { ...ctx(1), action: action({ id: 'A-2', amount: 1, counterparty: 'globex' }) };
    expect(checkConstraint(c('counterparty'), bad)).toMatchObject({ violated: true, reason: 'COUNTERPARTY_NOT_APPROVED' });
  });

  it('amount_lte boundary and reason depends on outcome', () => {
    expect(checkConstraint(c('autonomous'), ctx(10)).violated).toBe(false);
    expect(checkConstraint(c('autonomous'), ctx(10.01))).toMatchObject({ violated: true, reason: 'ABOVE_AUTONOMOUS_LIMIT' });
    expect(checkConstraint(c('hard_cap'), ctx(50)).violated).toBe(false);
    expect(checkConstraint(c('hard_cap'), ctx(50.01))).toMatchObject({ violated: true, reason: 'AMOUNT_ABOVE_HARD_CAP' });
  });

  it('daily_spend_lte counts today and resets on a new day', () => {
    expect(checkConstraint(c('daily_cap'), ctx(9, 135, 41)).violated).toBe(false);
    expect(checkConstraint(c('daily_cap'), ctx(9, 135, 41.01))).toMatchObject({ violated: true, reason: 'DAILY_CAP_EXCEEDED' });
    const yesterday = ctx(9, 135, 45);
    const fresh = { ...yesterday, state: { ...yesterday.state, day_index: yesterday.dayIndex - 1 } };
    expect(checkConstraint(c('daily_cap'), fresh).violated).toBe(false);
  });

  it('balance_after_gte', () => {
    expect(checkConstraint(c('treasury_floor'), ctx(8.58, 108.58)).violated).toBe(false);
    expect(checkConstraint(c('treasury_floor'), ctx(9, 108.58))).toMatchObject({ violated: true, reason: 'TREASURY_FLOOR_VIOLATION' });
    expect(checkConstraint(c('treasury_floor'), ctx(9, 5))).toMatchObject({ violated: true, reason: 'TREASURY_FLOOR_VIOLATION' });
  });

  it('verified_facts uses the report reason', () => {
    const a = action({ id: 'A-1', amount: 1 });
    const ok = { ...ctx(1), action: a, verification: verified(a) };
    expect(checkConstraint(c('invoice_facts'), ok).violated).toBe(false);
    const bad = { ...ctx(1), action: a, verification: verified(a, 'MISMATCH', 'INVOICE_NOT_OPEN') };
    expect(checkConstraint(c('invoice_facts'), bad)).toMatchObject({ violated: true, reason: 'INVOICE_NOT_OPEN' });
  });

  it('verified_facts fails a VERIFIED report with a false fact, first false fact wins', () => {
    const a = action({ id: 'A-1', amount: 1 });
    const v = verified(a);
    const report = { ...v.report, facts: { ...v.report.facts, status_open: false, amount_match: false } };
    expect(checkConstraint(c('invoice_facts'), { ...ctx(1), action: a, verification: { ...v, report } })).toMatchObject({ violated: true, reason: 'INVOICE_NOT_OPEN' });
  });

  it('details contain no bigint (canonical-JSON safe)', () => {
    const out = checkConstraint(c('treasury_floor'), ctx(9, 108.58));
    expect(Object.values(out.detail).every((v) => typeof v !== 'bigint')).toBe(true);
  });
});
