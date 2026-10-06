import type { ActionIR, ApprovalRequirement, AuthorizationRecord, Evaluation, VerificationReport } from '@authority/core';
import type { AttackId, EventType, Layer, Payloads, RunEvent } from './contract';

export type CardState =
  | 'PROPOSED'
  | 'EVALUATING'
  | 'VERIFYING'
  | 'AUTHORIZED'
  | 'REQUIRES_APPROVAL'
  | 'DENIED'
  | 'EXECUTING'
  | 'SETTLED'
  | 'PROVEN';

export interface CardView {
  actionId: string;
  state: CardState;
  proposedAt: string;
  action: ActionIR | null;
  actionHash: string | null;
  agentSignature: string | null;
  evaluation: Evaluation | null;
  verifying: boolean;
  verification: { report: VerificationReport; reportHash: string; sepoliaTx: string } | null;
  authorization: AuthorizationRecord | null;
  compromisedEngine: boolean;
  approval: { id: string; status: 'pending' | 'approved' | 'declined'; required: ApprovalRequirement[] } | null;
  denied: { reason: string; layer: Layer } | null;
  tx: { hash: string | null; bodyCbor: string | null; submittedAt: string | null; confirmedAt: string | null; block: number | null };
  receipt: { id: string; hash: string } | null;
}

export interface RunView {
  runId: string | null;
  started: Payloads['RunStarted'] | null;
  cards: CardView[];
  attacks: Partial<Record<AttackId, Payloads['AttackResult'] | 'running'>>;
  mandateTxs: Array<{ type: 'MandateUpdated' | 'MandateRevoked'; version: number; txHash: string }>;
  lastSeq: number;
  lastAt: string | null;
  ignored: number;
}

export const emptyRun = (): RunView => ({
  runId: null,
  started: null,
  cards: [],
  attacks: {},
  mandateTxs: [],
  lastSeq: 0,
  lastAt: null,
  ignored: 0,
});

const newCard = (actionId: string, at: string): CardView => ({
  actionId,
  state: 'PROPOSED',
  proposedAt: at,
  action: null,
  actionHash: null,
  agentSignature: null,
  evaluation: null,
  verifying: false,
  verification: null,
  authorization: null,
  compromisedEngine: false,
  approval: null,
  denied: null,
  tx: { hash: null, bodyCbor: null, submittedAt: null, confirmedAt: null, block: null },
  receipt: null,
});

function cardPatch(e: RunEvent, c: CardView): Partial<CardView> | null {
  switch (e.type) {
    case 'ActionProposed':
      return { action: e.payload.action, actionHash: e.payload.action_hash, agentSignature: e.payload.agent_signature, state: 'PROPOSED' };
    case 'AuthorityEvaluationStarted':
      return { state: 'EVALUATING' };
    case 'AuthorityEvaluated':
      return { evaluation: e.payload.evaluation };
    case 'CREVerificationStarted':
      return { state: 'VERIFYING', verifying: true };
    case 'CREVerificationCompleted':
      return {
        verifying: false,
        verification: { report: e.payload.report, reportHash: e.payload.report_hash, sepoliaTx: e.payload.sepolia_tx },
      };
    case 'AuthorizationIssued':
      return { authorization: e.payload.authorization, compromisedEngine: e.payload.compromised_engine, state: 'AUTHORIZED' };
    case 'ApprovalRequested':
      return {
        state: 'REQUIRES_APPROVAL',
        approval: { id: e.payload.approval_id, status: 'pending', required: e.payload.approvals_required },
      };
    case 'CFOApproved':
      return { approval: c.approval && { ...c.approval, status: 'approved' } };
    case 'CFODeclined':
      return {
        state: 'DENIED',
        approval: c.approval && { ...c.approval, status: 'declined' },
        denied: { reason: 'PRINCIPAL_DECLINED', layer: 'principal' },
      };
    case 'ActionDenied':
      return { state: 'DENIED', denied: { reason: e.payload.reason, layer: e.payload.layer } };
    case 'TransactionBuilt':
      return { state: 'EXECUTING', tx: { ...c.tx, hash: e.payload.tx_hash, bodyCbor: e.payload.tx_body_cbor } };
    case 'TransactionSubmitted':
      return { state: 'EXECUTING', tx: { ...c.tx, hash: e.payload.tx_hash, submittedAt: e.created_at } };
    case 'TransactionConfirmed':
      return { state: 'SETTLED', tx: { ...c.tx, hash: e.payload.tx_hash, confirmedAt: e.created_at, block: e.payload.block_height } };
    case 'TransactionRejected':
      return {
        state: 'DENIED',
        denied: { reason: e.payload.invariant, layer: 'vault' },
        tx: { ...c.tx, hash: e.payload.tx_hash, bodyCbor: e.payload.tx_body_cbor ?? c.tx.bodyCbor },
      };
    case 'ReceiptProven':
      return { state: 'PROVEN', receipt: { id: e.payload.receipt_id, hash: e.payload.receipt_hash } };
    default:
      return null;
  }
}

/** Every event type this reducer understands. Anything else (a newer server, a corrupt frame) is dropped untouched. */
export const EVENT_TYPES: readonly EventType[] = [
  'RunStarted',
  'ActionProposed',
  'AuthorityEvaluationStarted',
  'AuthorityEvaluated',
  'CREVerificationStarted',
  'CREVerificationCompleted',
  'AuthorizationIssued',
  'ApprovalRequested',
  'CFOApproved',
  'CFODeclined',
  'ActionDenied',
  'TransactionBuilt',
  'TransactionSubmitted',
  'TransactionConfirmed',
  'TransactionRejected',
  'ReceiptProven',
  'AttackStarted',
  'AttackResult',
  'MandateUpdated',
  'MandateRevoked',
];

/** Pure reducer: one event in, a new view out. Duplicate or out-of-order events (seq <= lastSeq) are ignored. */
export function applyEvent(view: RunView, e: RunEvent): RunView {
  if (!EVENT_TYPES.includes(e.type)) return view;
  if (e.seq <= view.lastSeq) return { ...view, ignored: view.ignored + 1 };
  const next: RunView = { ...view, runId: view.runId ?? e.run_id, lastSeq: e.seq, lastAt: e.created_at };
  switch (e.type) {
    case 'RunStarted':
      return { ...next, started: e.payload };
    case 'AttackStarted':
      return { ...next, attacks: { ...next.attacks, [e.payload.attack]: 'running' } };
    case 'AttackResult':
      return { ...next, attacks: { ...next.attacks, [e.payload.attack]: e.payload } };
    case 'MandateUpdated':
    case 'MandateRevoked':
      return { ...next, mandateTxs: [...next.mandateTxs, { type: e.type, version: e.payload.version, txHash: e.payload.tx_hash }] };
  }
  if (e.action_id === null) return { ...next, ignored: next.ignored + 1 };
  const index = next.cards.findIndex((c) => c.actionId === e.action_id);
  const card = index >= 0 ? (next.cards[index] as CardView) : newCard(e.action_id, e.created_at);
  const patch = cardPatch(e, card);
  if (patch === null) return { ...next, ignored: next.ignored + 1 };
  const updated = { ...card, ...patch };
  const cards = index >= 0 ? next.cards.map((c, i) => (i === index ? updated : c)) : [...next.cards, updated];
  return { ...next, cards };
}

export const reduceRun = (events: RunEvent[]): RunView => events.reduce(applyEvent, emptyRun());

export type RowTone = 'pending' | 'pass' | 'approval' | 'fail' | 'skipped';
export interface Row {
  value: string;
  tone: RowTone;
  reason: string | null;
}

const FACT_KIND = 'verified_facts';

/** MAY? row: the Authority Engine's own verdict, excluding the external-fact check (that is TRUE?). */
export function mayRow(c: CardView): Row {
  const ev = c.evaluation;
  if (c.compromisedEngine) return { value: 'BYPASSED', tone: 'fail', reason: 'Signed directly with a stolen engine key' };
  if (!ev) return { value: c.state === 'EVALUATING' ? 'Evaluating…' : '—', tone: 'pending', reason: null };
  const own = ev.checks.filter((k) => k.kind !== FACT_KIND);
  const failed = own.find((k) => k.result === 'fail');
  if (failed) return { value: 'DENY', tone: 'fail', reason: failed.reason };
  const approval = own.find((k) => k.result === 'approval');
  if (approval) return { value: 'REQUIRES APPROVAL', tone: 'approval', reason: approval.reason };
  return { value: 'ALLOW', tone: 'pass', reason: null };
}

/** TRUE? row: Chainlink CRE's attestation of the invoice facts. */
export function trueRow(c: CardView): Row {
  if (c.verification) {
    const r = c.verification.report;
    return r.result === 'VERIFIED'
      ? { value: 'VERIFIED', tone: 'pass', reason: null }
      : { value: 'MISMATCH', tone: 'fail', reason: r.reason };
  }
  if (c.verifying) return { value: 'Verifying…', tone: 'pending', reason: null };
  if (mayRow(c).tone === 'fail' || c.compromisedEngine) return { value: 'Not reached', tone: 'skipped', reason: null };
  return { value: '—', tone: 'pending', reason: null };
}

/** ENFORCED row: what the Cardano vault did. */
export function enforcedRow(c: CardView): Row {
  if (c.denied?.layer === 'vault') return { value: 'REJECTED', tone: 'fail', reason: c.denied.reason };
  if (c.state === 'SETTLED' || c.state === 'PROVEN') return { value: 'SETTLED', tone: 'pass', reason: null };
  if (c.state === 'EXECUTING') return { value: 'Executing…', tone: 'pending', reason: null };
  if (c.state === 'DENIED') return { value: 'Not reached', tone: 'skipped', reason: null };
  if (c.approval?.status === 'pending') return { value: 'Waiting for CFO', tone: 'approval', reason: null };
  return { value: '—', tone: 'pending', reason: null };
}

const STOPPED_BY: Record<Layer, string> = {
  agent: 'the agent',
  engine: 'the mandate',
  cre: 'the invoice check',
  vault: 'the vault',
  principal: 'the CFO',
};

/** The card's one-line outcome in business words. The MAY? / TRUE? / ENFORCED rows hold the technical detail. */
export function statusLine(c: CardView): { text: string; tone: RowTone } {
  const paid = c.approval?.status === 'approved' ? 'Paid with CFO approval' : 'Paid by the agent alone';
  switch (c.state) {
    case 'PROPOSED':
      return { text: 'Proposed by the agent', tone: 'pending' };
    case 'EVALUATING':
      return { text: 'Checking the mandate…', tone: 'pending' };
    case 'VERIFYING':
      return { text: 'Checking the invoice…', tone: 'pending' };
    case 'REQUIRES_APPROVAL':
      return { text: 'Waiting for CFO approval', tone: 'approval' };
    case 'AUTHORIZED':
    case 'EXECUTING':
      return { text: 'Paying on Cardano…', tone: 'pending' };
    case 'SETTLED':
      return { text: paid, tone: 'pass' };
    case 'PROVEN':
      return { text: `${paid} · Receipt ${c.receipt?.id ?? ''}`, tone: 'pass' };
    case 'DENIED':
      return { text: `Stopped by ${c.denied ? STOPPED_BY[c.denied.layer] : 'the boundary'}`, tone: 'fail' };
  }
}

/** Treasury and today's spend after the payments this run settled, from the vault state RunStarted carries. */
export function treasury(view: RunView): { balance: bigint; spent: bigint } | null {
  if (!view.started) return null;
  const settled = view.cards.reduce(
    (sum, c) => ((c.state === 'SETTLED' || c.state === 'PROVEN') && c.authorization ? sum + BigInt(c.authorization.fields.amount) : sum),
    0n,
  );
  return { balance: BigInt(view.started.vault.balance) - settled, spent: BigInt(view.started.vault.spent_today) + settled };
}
