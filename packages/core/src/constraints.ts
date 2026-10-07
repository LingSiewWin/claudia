import type { ActionIR, Constraint, FxVerificationReport, MandateFx, ReasonCode, State, VerificationReport, VerifiedReport } from './schemas';

export interface ConstraintContext {
  action: ActionIR;
  amount: bigint;
  state: State;
  dayIndex: number;
  nowMs: number;
  verification: VerifiedReport | null;
  mandateAsset: string;
  mandateFx?: MandateFx | undefined;
}

/** A quote must outlive the decision by at least this much (the human reads the brief, the agent locks the contract). */
export const FX_QUOTE_MIN_REMAINING_MS = 60_000;

/**
 * Whether a constraint speaks to this action at all. fx_* kinds and Crebit facts apply only to fx_lock; Stripe
 * facts apply to everything else. A constraint that does not apply passes without being evaluated.
 */
export function appliesTo(c: Constraint, action: ActionIR): boolean {
  const fx = action.type === 'fx_lock';
  if (c.kind === 'verified_facts') return c.source === 'crebit' ? fx : !fx;
  if (c.kind.startsWith('fx_')) return fx;
  return true;
}

/** Constraints that need a verification report before they can be evaluated. */
export const needsVerification = (c: Constraint) => c.kind === 'verified_facts' || c.kind === 'fx_basis_lte';

export type Detail = Record<string, string | number | boolean | null>;

export interface ConstraintOutcome {
  violated: boolean;
  reason: ReasonCode | null;
  detail: Detail;
}

type Facts = VerificationReport['facts'];
// Compile error if a fact is added to a report schema without a reason here.
type AssertNever<T extends never> = T;

// Fiat currency a verified invoice must be in for each mandate asset. An asset missing here never verifies.
const ASSET_FIAT = new Map([['USDM', 'usd']]);

const FX_FACT_REASONS = [
  ['quote_exists', 'QUOTE_NOT_FOUND'],
  ['rate_match', 'RATE_MISMATCH'],
  ['premium_match', 'PREMIUM_MISMATCH'],
  ['expiry_match', 'EXPIRY_MISMATCH'],
  ['basis_ok', 'QUOTE_OFF_MARKET'],
] as const satisfies readonly (readonly [keyof FxVerificationReport['facts'], ReasonCode])[];
type UncoveredFxFacts = AssertNever<Exclude<keyof FxVerificationReport['facts'], (typeof FX_FACT_REASONS)[number][0]>>;

const FACT_REASONS = [
  ['exists', 'INVOICE_NOT_FOUND'],
  ['customer_match', 'CUSTOMER_MISMATCH'],
  ['status_open', 'INVOICE_NOT_OPEN'],
  ['amount_match', 'AMOUNT_MISMATCH'],
  ['currency_match', 'CURRENCY_MISMATCH'],
  ['recipient_match', 'RECIPIENT_MISMATCH'],
] as const satisfies readonly (readonly [keyof Facts, ReasonCode])[];

type UncoveredFacts = AssertNever<Exclude<keyof Facts, (typeof FACT_REASONS)[number][0]>>;

const pass = (detail: Detail): ConstraintOutcome => ({ violated: false, reason: null, detail });
const fail = (reason: ReasonCode, detail: Detail): ConstraintOutcome => ({ violated: true, reason, detail });
const verdict = (ok: boolean, reason: ReasonCode, detail: Detail) => (ok ? pass(detail) : fail(reason, detail));

export function checkConstraint(c: Constraint, ctx: ConstraintContext): ConstraintOutcome {
  const { action, amount, state } = ctx;
  if (!appliesTo(c, action)) return pass({ applies: false });
  if (c.kind.startsWith('fx_') || (c.kind === 'verified_facts' && c.source === 'crebit')) return checkFx(c, ctx);
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
      const r = v.report;
      if (r.schema !== 'verification/v0.1') return fail('VERIFICATION_UNAVAILABLE', { report_hash: v.report_hash, report_schema: r.schema });
      const detail: Detail = {
        report_hash: v.report_hash,
        invoice_id: r.invoice_id,
        result: r.result,
        verified_recipient: r.verified_recipient,
        verified_amount: r.verified_amount,
        verified_currency: r.verified_currency,
      };
      if (r.result !== 'VERIFIED') return fail(r.reason ?? 'VERIFICATION_UNAVAILABLE', detail);
      const broken = FACT_REASONS.find(([fact]) => !r.facts[fact]);
      if (broken) return fail(broken[1], detail);
      // The facts are computed from the trigger request, so compare the verified values with the action itself.
      if (r.verified_recipient !== action.recipient.address) return fail('RECIPIENT_MISMATCH', detail);
      if (r.verified_amount !== action.amount.value) return fail('AMOUNT_MISMATCH', detail);
      const fiat = ASSET_FIAT.get(ctx.mandateAsset);
      if (fiat === undefined || r.verified_currency !== fiat) return fail('CURRENCY_MISMATCH', detail);
      // An invoice payment without an invoice reference can never pass verification.
      if (!action.reference || r.invoice_id !== action.reference.invoice_id) return fail('INVOICE_NOT_FOUND', detail);
      return pass(detail);
    }
    default:
      throw new Error(`unreachable constraint kind ${c.kind}`);
  }
}

/** fx_lock constraints: limits come from mandate.fx; a mandate without one authorizes no lock at all. */
function checkFx(c: Constraint, ctx: ConstraintContext): ConstraintOutcome {
  const fx = ctx.action.fx;
  const m = ctx.mandateFx;
  if (fx === undefined) throw new Error('fx constraint checked on an action without an fx block');
  if (m === undefined) return fail('FX_NOT_AUTHORIZED', { kind: c.kind });
  switch (c.kind) {
    case 'fx_corridor_in':
      return verdict(m.corridors.includes(fx.corridor), 'FX_CORRIDOR_NOT_AUTHORIZED', { corridor: fx.corridor, allowed: m.corridors.join(',') });
    case 'fx_notional_lte':
      return verdict(BigInt(fx.notional) <= BigInt(m.max_notional), 'FX_NOTIONAL_ABOVE_LIMIT', { notional: fx.notional, limit: m.max_notional });
    case 'fx_tenor_lte':
      return verdict(fx.tenor_hours <= m.max_tenor_hours, 'FX_TENOR_ABOVE_LIMIT', { tenor_hours: fx.tenor_hours, limit: m.max_tenor_hours });
    case 'fx_contract_type_in':
      return verdict(m.contract_types.includes(fx.contract_type), 'FX_CONTRACT_TYPE_NOT_AUTHORIZED', { contract_type: fx.contract_type, allowed: m.contract_types.join(',') });
    case 'fx_quote_fresh': {
      const remaining = Date.parse(fx.quote_expires_at) - ctx.nowMs;
      return verdict(remaining > FX_QUOTE_MIN_REMAINING_MS, 'FX_QUOTE_STALE', { quote_expires_at: fx.quote_expires_at, remaining_ms: remaining, minimum_ms: FX_QUOTE_MIN_REMAINING_MS });
    }
    case 'fx_basis_lte':
    case 'verified_facts': {
      const v = ctx.verification;
      if (v === null) throw new Error(`${c.kind} checked without a verification report`);
      const r = v.report;
      if (r.schema !== 'fx-verification/v0.1') return fail('VERIFICATION_UNAVAILABLE', { report_hash: v.report_hash, report_schema: r.schema });
      const detail: Detail = { report_hash: v.report_hash, quote_id: r.quote_id, quote_hash: r.quote_hash, result: r.result, basis_bps: r.basis_bps, basis_source: r.basis_source };
      if (r.quote_id !== fx.quote_id) return fail('QUOTE_NOT_FOUND', detail);
      if (c.kind === 'fx_basis_lte') {
        if (r.basis_bps === null) return fail('QUOTE_OFF_MARKET', { ...detail, limit_bps: m.max_basis_bps });
        return verdict(r.basis_bps <= m.max_basis_bps, 'QUOTE_OFF_MARKET', { ...detail, limit_bps: m.max_basis_bps });
      }
      if (r.result !== 'VERIFIED') return fail(r.reason ?? 'VERIFICATION_UNAVAILABLE', detail);
      const broken = FX_FACT_REASONS.find(([fact]) => !r.facts[fact]);
      if (broken) return fail(broken[1], detail);
      if (r.verified_rate !== fx.locked_rate) return fail('RATE_MISMATCH', detail);
      if (r.verified_premium !== fx.premium || r.verified_deposit !== fx.deposit) return fail('PREMIUM_MISMATCH', detail);
      if (r.verified_expires_at !== fx.quote_expires_at) return fail('EXPIRY_MISMATCH', detail);
      return pass(detail);
    }
    default:
      throw new Error(`unreachable fx constraint kind ${c.kind}`);
  }
}
