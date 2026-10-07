import type { Evaluation } from './engine';
import { canonicalHash } from './hash';
import { enforcementLimits } from './mandate';
import type { ActionIR, Mandate, ReasonCode, VerificationReport } from './schemas';

/*
 * Decision Brief (brief/v0.1): what a human reads before authorizing. Built from the Action IR, the engine's
 * evaluation, the mandate and the verified facts by pure functions; no model writes any of it. Deterministic:
 * the same inputs give byte-identical JSON, so brief_hash can sit in the receipt and be recomputed by anyone.
 */

export interface BriefInput {
  action: ActionIR;
  evaluation: Evaluation;
  mandate: Mandate;
  verification: { report: VerificationReport; report_hash: string; sepolia_tx: string | null } | null;
  bond: { amount: string; asset: string } | null;
  expires_at_ms: number;
}

export interface DecisionBrief {
  schema: 'brief/v0.1';
  action_id: string;
  action_hash: string;
  requested_by: string;
  mandate: { id: string; version: number; hash: string };
  what: {
    type: ActionIR['type'];
    amount: { value: string; asset: string; display: string };
    counterparty: { id: string; display: string };
    recipient: string;
    reference: { invoice_id: string; invoice_number: string } | null;
  };
  why: string;
  engine: {
    outcome: Evaluation['outcome'];
    reason: ReasonCode | null;
    checks: { id: string; kind: string; result: string; reason: ReasonCode | null }[];
  };
  escalation: { approver: string; because: { constraint: string; reason: ReasonCode }[] } | null;
  verified: {
    report_hash: string;
    sepolia_tx: string | null;
    result: VerificationReport['result'];
    facts: VerificationReport['facts'];
  } | null;
  limits: { autonomous_limit: string; hard_cap: string; daily_cap: string; treasury_minimum: string };
  will_happen: string;
  expires_at_ms: number;
  cost: { bond: { amount: string; asset: string } | null; interrupt_budget: { used: number; per_day: number } };
}

/** Base units to a decimal string, integer math only. formatUnits('8420000', 6) = '8.42'. */
export function formatUnits(value: string, decimals: number): string {
  if (!/^\d+$/.test(value)) throw new TypeError('formatUnits: expected a base-unit integer string');
  if (!Number.isInteger(decimals) || decimals < 0) throw new TypeError('formatUnits: bad decimals');
  if (decimals === 0) return value;
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return frac.length ? `${whole}.${frac}` : whole;
}

export function buildBrief(input: BriefInput): DecisionBrief {
  const { action, evaluation: e, mandate } = input;
  const actionHash = canonicalHash(action);
  if (e.action_hash !== actionHash) throw new Error('buildBrief: evaluation is for another action');
  if (e.mandate_version !== mandate.version || e.mandate_hash !== canonicalHash(mandate)) {
    throw new Error('buildBrief: evaluation is under another mandate');
  }
  if (!Number.isSafeInteger(input.expires_at_ms) || input.expires_at_ms <= 0) throw new TypeError('buildBrief: expires_at_ms');
  const l = enforcementLimits(mandate);
  const str = (x: bigint | null) => (x === null ? '0' : x.toString());
  const display = `${formatUnits(action.amount.value, mandate.asset.decimals)} ${action.amount.asset}`;
  const approver = e.approvals_required[0]?.approver ?? null;
  const budget = e.checks.find((c) => c.id === 'interrupt_budget')?.detail ?? {};
  const used = typeof budget.used === 'number' ? budget.used : 0;
  const reference = action.reference
    ? ` for invoice ${action.reference.invoice_number} (${action.reference.invoice_id})`
    : '';
  const v = input.verification;
  return {
    schema: 'brief/v0.1',
    action_id: action.id,
    action_hash: actionHash,
    requested_by: action.actor,
    mandate: { id: mandate.id, version: mandate.version, hash: e.mandate_hash },
    what: {
      type: action.type,
      amount: { value: action.amount.value, asset: action.amount.asset, display },
      counterparty: { id: action.counterparty.id, display: action.counterparty.display },
      recipient: action.recipient.address,
      reference: action.reference ?? null,
    },
    why: action.rationale,
    engine: {
      outcome: e.outcome,
      reason: e.reason,
      checks: e.checks.map((c) => ({ id: c.id, kind: c.kind, result: c.result, reason: c.reason })),
    },
    escalation:
      approver === null
        ? null
        : { approver, because: e.approvals_required.map((a) => ({ constraint: a.constraint, reason: a.reason })) },
    verified: v === null ? null : { report_hash: v.report_hash, sepolia_tx: v.sepolia_tx, result: v.report.result, facts: v.report.facts },
    limits: { autonomous_limit: str(l.autonomous), hard_cap: str(l.hardCap), daily_cap: str(l.dailyCap), treasury_minimum: str(l.treasuryMinimum) },
    will_happen:
      `Release ${display} from vault ${action.source.vault} to ${action.recipient.address}` +
      ` for ${action.counterparty.display}${reference}. Nothing else is authorized by this signature.`,
    expires_at_ms: input.expires_at_ms,
    cost: { bond: input.bond, interrupt_budget: { used, per_day: mandate.interrupt_budget.per_day } },
  };
}

export const briefHash = (brief: DecisionBrief): string => canonicalHash(brief);
