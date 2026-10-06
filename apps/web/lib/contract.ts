import {
  type ActionIR,
  type ApprovalRequirement,
  type AuthorizationRecord,
  type Evaluation,
  type Mandate,
  type ReasonCode,
  type VerificationReport,
  canonicalJson,
} from '@authority/core';

export type Layer = 'agent' | 'engine' | 'cre' | 'vault' | 'principal';
export type RunKind = 'stage' | 'lab' | 'masumi';
export const ATTACK_IDS = [
  'prompt_injection',
  'prompt_injection_direct',
  'recipient_swap',
  'amount_swap',
  'replay',
  'expired',
  'revoked',
  'daily_cap',
  'cfo_bypass',
] as const;
export type AttackId = (typeof ATTACK_IDS)[number];

export interface Limits {
  symbol: string;
  decimals: number;
  autonomous_limit: string;
  hard_cap: string;
  daily_cap: string;
  treasury_minimum: string;
}

export interface Payloads {
  RunStarted: {
    kind: RunKind;
    mandate_id: string;
    mandate_version: number;
    principal: string;
    delegate: string;
    agent_public_key: string;
    engine_public_key: string;
    limits: Limits;
    /** Vault state read from Cardano when the run started (base units). */
    vault: { balance: string; spent_today: string };
    goal: string;
  };
  ActionProposed: { action: ActionIR; action_hash: string; agent_signature: string | null };
  AuthorityEvaluationStarted: { mandate_id: string; mandate_version: number };
  AuthorityEvaluated: { evaluation: Evaluation };
  CREVerificationStarted: { trigger_id: string };
  CREVerificationCompleted: { report: VerificationReport; report_hash: string; sepolia_tx: string };
  AuthorizationIssued: { authorization: AuthorizationRecord; compromised_engine: boolean };
  ApprovalRequested: { approval_id: string; approvals_required: ApprovalRequirement[] };
  CFOApproved: { approval_id: string; cfo_key_hash: string };
  CFODeclined: { approval_id: string };
  ActionDenied: { reason: ReasonCode; layer: Layer };
  TransactionBuilt: { tx_hash: string; tx_body_cbor: string };
  TransactionSubmitted: { tx_hash: string };
  TransactionConfirmed: { tx_hash: string; block_height: number };
  TransactionRejected: { tx_hash: string | null; invariant: string; error: string; tx_body_cbor: string | null };
  ReceiptProven: { receipt_id: string; receipt_hash: string };
  AttackStarted: { attack: AttackId; mandate_id: string };
  AttackResult: { attack: AttackId; stopped_by: Layer; code: string; funds_moved: string; tx_hash: string | null };
  MandateUpdated: { mandate_id: string; version: number; tx_hash: string };
  MandateRevoked: { mandate_id: string; version: number; tx_hash: string };
}
export type EventType = keyof Payloads;

interface Envelope {
  seq: number;
  run_id: string;
  action_id: string | null;
  created_at: string;
  hash: string;
  prev_hash: string;
}
export type RunEvent = { [K in EventType]: Envelope & { type: K; payload: Payloads[K] } }[EventType];

export interface RunSummary {
  run_id: string;
  kind: RunKind;
  mandate_id: string;
  started_at: string;
  event_count: number;
  attack: AttackId | null;
}

export interface MandateView {
  mandate: Mandate;
  mandate_hash: string;
  limits: Limits;
  anchor: { mandate_ref: string; version: number; status: 'active' | 'revoked'; tx_hash: string };
  vault: { vault_hash: string; balance: string; spent_today: string; day_index: number; last_nonce: string; tx_hash: string };
}

export interface ApprovalView {
  approval_id: string;
  run_id: string;
  action: ActionIR;
  evaluation: Evaluation;
  requested_at: string;
}

export interface Receipt {
  schema: 'receipt/v0.1';
  principal: string;
  delegate: string;
  mandate: { id: string; version: number; hash: string; anchor: string };
  action: { ir: ActionIR; hash: string; agent_signature: string };
  evaluation: { outcome: string; reason: string | null; checks: Evaluation['checks'] };
  verification: { id: string; report_hash: string; sepolia_tx: string; result: string } | null;
  authorization: {
    id: string;
    verification_id: string | null;
    digest: string;
    signature: string;
    engine_public_key: string;
    nonce: string;
    valid_until: number;
  };
  approval: { required: boolean; cfo_key_hash: string | null };
  settlement: { chain: 'cardano-preprod'; tx_hash: string; block: number };
  masumi: unknown;
  evidence: { first_event_hash: string; last_event_hash: string };
}

export interface ReceiptBundle {
  receipt: Receipt;
  receipt_hash: string;
  authorization: AuthorizationRecord;
  mandate: Mandate;
}

export interface ReceiptSummary {
  receipt_id: string;
  action_id: string;
  counterparty: string;
  amount: string;
  settled_tx: string;
  created_at: string;
}

/**
 * The exact text the CFO signs (CIP-30 signData, CIP-8 COSE_Sign1) to decline an approval.
 * The API rebuilds it from the approval id and accepts the decline only when the COSE_Sign1 payload equals it
 * and the signing key hashes to the mandate's CFO key hash.
 */
export const declineMessage = (approvalId: string) => canonicalJson({ approval_id: approvalId, decision: 'decline' });

/** CIP-30 DataSignature: hex CBOR of a COSE_Sign1 and of a COSE_Key. */
export interface DeclineSignature {
  signature: string;
  key: string;
}
