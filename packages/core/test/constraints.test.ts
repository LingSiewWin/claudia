import { describe, expect, it } from 'vitest';
import { checkConstraint, type ConstraintContext } from '../src/constraints';
import type { ActionIR, Constraint, VerificationReport } from '../src/schemas';
import { ATTACKER_ADDR, AWS_ADDR, M001, NOW, action, state, usdm, verified } from './fixtures';

const c = (id: string) => M001.constraints.find((x) => x.id === id) as Constraint;
const ctx = (amount: number, balance = 135, spent = 0, overrides: Partial<ConstraintContext> = {}): ConstraintContext => {
  const a = action({ id: 'A-1', amount });
  return { action: a, amount: BigInt(usdm(amount)), state: state(balance, spent), dayIndex: Math.floor(NOW / 86_400_000), verification: null, mandateAsset: 'USDM', ...overrides };
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

  it('asset_eq maps to ASSET_NOT_AUTHORIZED', () => {
    expect(checkConstraint(c('asset'), ctx(1)).violated).toBe(false);
    const a = action({ id: 'A-2', amount: 1 });
    const bad = { ...ctx(1), action: { ...a, amount: { ...a.amount, asset: 'ADA' } } };
    expect(checkConstraint(c('asset'), bad)).toMatchObject({ violated: true, reason: 'ASSET_NOT_AUTHORIZED', detail: { asset: 'ADA' } });
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

  describe('verified_facts cross-checks a VERIFIED report against the action', () => {
    const a = action({ id: 'A-1', amount: 1 });
    const withReport = (act: ActionIR, patch: Partial<VerificationReport> = {}): ConstraintContext => {
      const v = verified(act);
      return { ...ctx(1), action: act, verification: { ...v, report: { ...v.report, ...patch } } };
    };

    it('legit vendor address in the report, attacker address in the action -> RECIPIENT_MISMATCH', () => {
      const redirected = action({ id: 'A-1', amount: 1, recipient: ATTACKER_ADDR });
      expect(checkConstraint(c('invoice_facts'), withReport(redirected, { verified_recipient: AWS_ADDR }))).toMatchObject({ violated: true, reason: 'RECIPIENT_MISMATCH' });
    });

    it('null verified_recipient -> RECIPIENT_MISMATCH', () => {
      expect(checkConstraint(c('invoice_facts'), withReport(a, { verified_recipient: null }))).toMatchObject({ violated: true, reason: 'RECIPIENT_MISMATCH' });
    });

    it('amount one base unit off -> AMOUNT_MISMATCH', () => {
      const off = (BigInt(a.amount.value) + 1n).toString();
      expect(checkConstraint(c('invoice_facts'), withReport(a, { verified_amount: off }))).toMatchObject({ violated: true, reason: 'AMOUNT_MISMATCH' });
    });

    it('null verified_amount -> AMOUNT_MISMATCH', () => {
      expect(checkConstraint(c('invoice_facts'), withReport(a, { verified_amount: null }))).toMatchObject({ violated: true, reason: 'AMOUNT_MISMATCH' });
    });

    it('report invoice id differs from the action reference -> INVOICE_NOT_FOUND', () => {
      expect(checkConstraint(c('invoice_facts'), withReport(a, { invoice_id: 'in_other' }))).toMatchObject({ violated: true, reason: 'INVOICE_NOT_FOUND' });
    });

    it('action without an invoice reference -> INVOICE_NOT_FOUND', () => {
      const unreferenced = action({ id: 'A-1', amount: 1, invoice: null });
      expect(checkConstraint(c('invoice_facts'), withReport(unreferenced))).toMatchObject({ violated: true, reason: 'INVOICE_NOT_FOUND' });
    });

    it('everything equal passes and the detail shows the verified values', () => {
      expect(checkConstraint(c('invoice_facts'), withReport(a))).toEqual({
        violated: false,
        reason: null,
        detail: expect.objectContaining({ verified_recipient: AWS_ADDR, verified_amount: a.amount.value, verified_currency: 'usd' }),
      });
    });

    it.each(['eur', null])('verified_currency %s for USDM -> CURRENCY_MISMATCH', (currency) => {
      expect(checkConstraint(c('invoice_facts'), withReport(a, { verified_currency: currency }))).toMatchObject({ violated: true, reason: 'CURRENCY_MISMATCH' });
    });

    it('verified_currency usd for USDM passes', () => {
      expect(checkConstraint(c('invoice_facts'), withReport(a, { verified_currency: 'usd' })).violated).toBe(false);
    });

    it('a mandate asset with no known fiat currency -> CURRENCY_MISMATCH', () => {
      expect(checkConstraint(c('invoice_facts'), { ...withReport(a), mandateAsset: 'USDC' })).toMatchObject({ violated: true, reason: 'CURRENCY_MISMATCH' });
    });

    it('a false fact wins over a cross-check mismatch', () => {
      const redirected = action({ id: 'A-1', amount: 1, recipient: ATTACKER_ADDR });
      const facts = { ...verified(redirected).report.facts, amount_match: false };
      expect(checkConstraint(c('invoice_facts'), withReport(redirected, { verified_recipient: AWS_ADDR, facts }))).toMatchObject({ violated: true, reason: 'AMOUNT_MISMATCH' });
    });

    it('recipient is cross-checked before amount', () => {
      expect(checkConstraint(c('invoice_facts'), withReport(a, { verified_recipient: ATTACKER_ADDR, verified_amount: '2' }))).toMatchObject({ violated: true, reason: 'RECIPIENT_MISMATCH' });
    });
  });

  it('details contain no bigint (canonical-JSON safe)', () => {
    const out = checkConstraint(c('treasury_floor'), ctx(9, 108.58));
    expect(Object.values(out.detail).every((v) => typeof v !== 'bigint')).toBe(true);
  });
});
