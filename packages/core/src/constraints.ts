import type { ActionIR, Constraint, ReasonCode, State, VerifiedReport } from './schemas';

export interface ConstraintContext {
  action: ActionIR;
  amount: bigint;
  state: State;
  dayIndex: number;
  verification: VerifiedReport | null;
}

export type Detail = Record<string, string | number | boolean | null>;

export interface ConstraintOutcome {
  violated: boolean;
  reason: ReasonCode | null;
  detail: Detail;
}

const pass = (detail: Detail): ConstraintOutcome => ({ violated: false, reason: null, detail });
const fail = (reason: ReasonCode, detail: Detail): ConstraintOutcome => ({ violated: true, reason, detail });
const verdict = (ok: boolean, reason: ReasonCode, detail: Detail) => (ok ? pass(detail) : fail(reason, detail));

export function checkConstraint(c: Constraint, ctx: ConstraintContext): ConstraintOutcome {
  const { action, amount, state } = ctx;
  switch (c.kind) {
    case 'purpose_in':
      return verdict(c.values.includes(action.purpose), 'PURPOSE_NOT_AUTHORIZED', { purpose: action.purpose });
    case 'action_in':
      return verdict(c.values.includes(action.type), 'ACTION_NOT_AUTHORIZED', { type: action.type });
    case 'asset_eq':
      return verdict(action.amount.asset === c.value, 'ASSET_NOT_AUTHORIZED', { asset: action.amount.asset });
    case 'counterparty_in':
      return verdict(c.values.includes(action.counterparty.id), 'COUNTERPARTY_NOT_APPROVED', {
        counterparty: action.counterparty.id,
      });
    case 'amount_lte': {
      const limit = BigInt(c.value);
      const reason: ReasonCode = c.on_violation === 'DENY' ? 'AMOUNT_ABOVE_HARD_CAP' : 'ABOVE_AUTONOMOUS_LIMIT';
      return verdict(amount <= limit, reason, { amount: amount.toString(), limit: c.value });
    }
    case 'daily_spend_lte': {
      const spent = ctx.state.day_index < ctx.dayIndex ? 0n : BigInt(state.spent_today);
      const after = spent + amount;
      return verdict(after <= BigInt(c.value), 'DAILY_CAP_EXCEEDED', {
        spent_today: spent.toString(),
        amount: amount.toString(),
        after: after.toString(),
        cap: c.value,
      });
    }
    case 'balance_after_gte': {
      const after = BigInt(state.vault_balance) - amount;
      return verdict(after >= BigInt(c.value), 'TREASURY_FLOOR_VIOLATION', {
        balance: state.vault_balance,
        amount: amount.toString(),
        after: after.toString(),
        minimum: c.value,
      });
    }
    case 'verified_facts': {
      const v = ctx.verification;
      if (v === null) throw new Error('verified_facts checked without a verification report');
      const detail: Detail = { report_hash: v.report_hash, invoice_id: v.report.invoice_id, result: v.report.result };
      return v.report.result === 'VERIFIED' ? pass(detail) : fail(v.report.reason ?? 'VERIFICATION_UNAVAILABLE', detail);
    }
  }
}
