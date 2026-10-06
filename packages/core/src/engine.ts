import { type Detail, checkConstraint } from './constraints';
import { canonicalHash } from './hash';
import { mandateHash } from './mandate';
import { verifyProposal } from './proposal';
import {
  type ActionIR,
  ActionIRSchema,
  type Mandate,
  type Outcome,
  type ReasonCode,
  type State,
  VerificationReportSchema,
  type VerifiedReport,
} from './schemas';

export const REPORT_MAX_AGE_MS = 600_000;
export const REPORT_MAX_FUTURE_SKEW_MS = 60_000;
export const DAY_MS = 86_400_000;

export type CheckResult = 'pass' | 'fail' | 'approval' | 'pending' | 'not_evaluated';

export interface Check {
  id: string;
  kind: string;
  result: CheckResult;
  reason: ReasonCode | null;
  detail: Detail;
}

export interface ApprovalRequirement {
  constraint: string;
  approver: string;
  reason: ReasonCode;
}

export interface Evaluation {
  outcome: Outcome | 'NEEDS_VERIFICATION';
  reason: ReasonCode | null;
  approvals_required: ApprovalRequirement[];
  checks: Check[];
  signed: boolean;
  action_hash: string | null;
  mandate_hash: string;
  mandate_version: number;
  verification_hash: string | null;
  evaluated_at_ms: number;
}

export interface EvaluateInput {
  mandate: Mandate;
  proposal: { action: unknown; agent_signature: string | null };
  state: State;
  verification: VerifiedReport | null;
  nowMs: number;
}

function usableReport(v: VerifiedReport | null, actionHash: string, nowMs: number): VerifiedReport | null {
  if (v === null) return null;
  if (!VerificationReportSchema.safeParse(v.report).success) return null;
  if (v.report.action_hash !== actionHash) return null;
  if (canonicalHash(v.report) !== v.report_hash) return null;
  if (!(nowMs - v.block_time_ms <= REPORT_MAX_AGE_MS)) return null;
  if (!(v.block_time_ms - nowMs <= REPORT_MAX_FUTURE_SKEW_MS)) return null;
  return v;
}

export function evaluate(input: EvaluateInput): Evaluation {
  const { mandate, state, nowMs } = input;
  if (!Number.isSafeInteger(nowMs)) throw new TypeError('evaluate: nowMs must be a safe integer');
  const checks: Check[] = [
    { id: 'proposal', kind: 'integrity', result: 'not_evaluated', reason: null, detail: {} },
    { id: 'mandate', kind: 'validity', result: 'not_evaluated', reason: null, detail: {} },
    ...mandate.constraints.map((c): Check => ({ id: c.id, kind: c.kind, result: 'not_evaluated', reason: null, detail: {} })),
  ];
  const approvals: ApprovalRequirement[] = [];
  let actionHash: string | null = null;
  let signed = false;
  let verificationHash: string | null = null;

  const set = (index: number, result: CheckResult, reason: ReasonCode | null, detail: Detail = {}) => {
    const current = checks[index];
    if (current) checks[index] = { ...current, result, reason, detail };
  };
  const finish = (outcome: Evaluation['outcome'], reason: ReasonCode | null): Evaluation => ({
    outcome,
    reason,
    approvals_required: approvals,
    checks,
    signed,
    action_hash: actionHash,
    mandate_hash: mandateHash(mandate),
    mandate_version: mandate.version,
    verification_hash: verificationHash,
    evaluated_at_ms: nowMs,
  });
  const deny = (index: number, reason: ReasonCode, detail: Detail = {}) => {
    set(index, 'fail', reason, detail);
    return finish('DENY', reason);
  };

  // 1. Proposal integrity
  const parsed = ActionIRSchema.safeParse(input.proposal.action);
  if (!parsed.success) return deny(0, 'INVALID_PROPOSAL', { issues: parsed.error.issues.length });
  const action: ActionIR = parsed.data;
  actionHash = canonicalHash(action);
  if (action.mandate_id !== mandate.id) return deny(0, 'WRONG_MANDATE', { mandate_id: action.mandate_id });
  if (action.actor !== mandate.delegate.id) return deny(0, 'AGENT_NOT_DELEGATE', { actor: action.actor });
  const signature = input.proposal.agent_signature;
  if (signature !== null) {
    const agentKey = mandate.delegate.public_key.slice('ed25519:'.length);
    if (!verifyProposal(actionHash, signature, agentKey)) return deny(0, 'INVALID_AGENT_SIGNATURE');
    signed = true;
  }
  set(0, 'pass', null, { signed, action_hash: actionHash });

  // 2. Mandate validity
  if (mandate.status !== 'active' || state.anchor_status !== 'active') return deny(1, 'MANDATE_REVOKED');
  if (state.anchor_version !== mandate.version) {
    return deny(1, 'MANDATE_VERSION_MISMATCH', { mandate_version: mandate.version, anchor_version: state.anchor_version });
  }
  if (!(nowMs >= Date.parse(mandate.validity.starts_at))) return deny(1, 'MANDATE_NOT_STARTED');
  if (!(nowMs < Date.parse(mandate.validity.expires_at))) return deny(1, 'MANDATE_EXPIRED');
  set(1, 'pass', null, { version: mandate.version });

  // 3. Constraints, in mandate order
  const amount = BigInt(action.amount.value);
  const dayIndex = Math.floor(nowMs / DAY_MS);
  for (const [offset, constraint] of mandate.constraints.entries()) {
    const index = offset + 2;
    let verification: VerifiedReport | null = null;
    if (constraint.kind === 'verified_facts') {
      verification = usableReport(input.verification, actionHash, nowMs);
      if (verification === null) {
        set(index, 'pending', null, { source: constraint.source });
        return finish('NEEDS_VERIFICATION', null);
      }
      verificationHash = verification.report_hash;
    }
    const out = checkConstraint(constraint, { action, amount, state, dayIndex, verification });
    if (!out.violated) {
      set(index, 'pass', null, out.detail);
      continue;
    }
    const reason = out.reason ?? 'VERIFICATION_UNAVAILABLE';
    if (constraint.on_violation === 'DENY') return deny(index, reason, out.detail);
    set(index, 'approval', reason, out.detail);
    if (constraint.approver === undefined) throw new Error(`evaluate: constraint ${constraint.id} has no approver`);
    approvals.push({ constraint: constraint.id, approver: constraint.approver, reason });
  }
  return finish(approvals.length > 0 ? 'REQUIRE_APPROVAL' : 'ALLOW', null);
}
