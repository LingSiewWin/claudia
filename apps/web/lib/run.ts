import type { ActionIR, ApprovalRequirement, AuthorizationRecord, DecisionBrief, Evaluation, VerificationReport } from '@authority/core';
import type { AttackId, EventType, Layer, Metrics, Payloads, RunEvent, BondRef, DeclineReason } from './contract';

export type CardState =
  | 'PROPOSED'
  | 'EVALUATING'
  | 'VERIFYING'
  | 'AUTHORIZED'
  | 'ESCALATED'
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
  approval: {
    id: string;
    status: 'pending' | 'approved' | 'declined';
    required: ApprovalRequirement[];
    brief: DecisionBrief | null;
    declineReason: DeclineReason | null;
    requestedAt: string;
    decidedAt: string | null;
  } | null;
  bond: BondRef | null;
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
  /** True once an event arrived with a skipped sequence number, or the stream began after the run started. */
  gap: boolean;
  /** Event counts that cards cannot carry (a bond moves through several states; a budget denial has no approval). */
  tally: Tally;
}

export interface Tally {
  /** Approvals that reached a human (ApprovalRequested). An ESCALATE stopped at the 402 or the budget is not one. */
  paged: number;
  bondRequired: number;
  bondLocked: number;
  bondRefunded: number;
  bondCaptured: number;
  budgetExhausted: number;
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
  gap: false,
  tally: { paged: 0, bondRequired: 0, bondLocked: 0, bondRefunded: 0, bondCaptured: 0, budgetExhausted: 0 },
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
  bond: null,
  denied: null,
  tx: { hash: null, bodyCbor: null, submittedAt: null, confirmedAt: null, block: null },
  receipt: null,
});

/** A base-unit amount, strictly: BigInt() alone also accepts '', ' 8' and '0x10'. Throws, so applyEvent ignores the event. */
export function units(value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new Error('Not a base-unit amount');
  return BigInt(value);
}

function cardPatch(e: RunEvent, c: CardView): Partial<CardView> | null {
  switch (e.type) {
    case 'ActionProposed':
      units(e.payload.action.amount.value);
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
      units(e.payload.authorization.fields.amount);
      return { authorization: e.payload.authorization, compromisedEngine: e.payload.compromised_engine, state: 'AUTHORIZED' };
    case 'ApprovalRequested':
      return {
        state: 'ESCALATED',
        approval: {
          id: e.payload.approval_id,
          status: 'pending',
          required: e.payload.approvals_required,
          brief: e.payload.brief ?? null,
          declineReason: null,
          requestedAt: e.created_at,
          decidedAt: null,
        },
        bond: e.payload.bond ?? c.bond,
      };
    case 'BondRequired':
      // The engine escalated and priced the interruption; the human is not reached until the bond is on chain.
      return {
        state: 'ESCALATED',
        bond: {
          amount: e.payload.price.amount,
          asset: e.payload.price.asset.symbol,
          escrow_address: e.payload.price.escrow_address,
          locked_until_ms: e.payload.price.locked_until_ms,
          tx_hash: null,
          output_index: null,
          status: 'required',
        },
      };
    case 'BondLocked':
      return c.bond && { bond: { ...c.bond, tx_hash: e.payload.tx_hash, output_index: e.payload.output_index, status: 'locked' } };
    case 'BondRefunded':
      return c.bond && { bond: { ...c.bond, status: 'refunded', outcome_tx_hash: e.payload.tx_hash } };
    case 'BondCaptured':
      return c.bond && { bond: { ...c.bond, status: 'captured', outcome_tx_hash: e.payload.tx_hash } };
    case 'CFOApproved':
      return { approval: c.approval && { ...c.approval, status: 'approved', decidedAt: e.created_at } };
    case 'CFODeclined':
      return {
        state: 'DENIED',
        approval: c.approval && { ...c.approval, status: 'declined', declineReason: e.payload.reason ?? null, decidedAt: e.created_at },
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
  'RunCompleted',
  'BondRequired',
  'BondLocked',
  'BondRefunded',
  'BondCaptured',
];

/** Pure reducer: one event in, a new view out. Duplicate or out-of-order events (seq <= lastSeq) are ignored. */
export function applyEvent(view: RunView, e: RunEvent): RunView {
  if (!EVENT_TYPES.includes(e.type)) return view;
  try {
    return applyKnown(view, e);
  } catch {
    return { ...view, ignored: view.ignored + 1 };
  }
}

function applyKnown(view: RunView, e: RunEvent): RunView {
  if (e.seq <= view.lastSeq) return { ...view, ignored: view.ignored + 1 };
  // Every run's log opens with RunStarted, so a stream that begins anywhere else has already lost events.
  const skipped = view.lastSeq === 0 ? e.type !== 'RunStarted' : e.seq > view.lastSeq + 1;
  const next: RunView = { ...view, runId: view.runId ?? e.run_id, lastSeq: e.seq, lastAt: e.created_at, gap: view.gap || skipped };
  switch (e.type) {
    case 'RunStarted': {
      const { vault, limits } = e.payload;
      for (const v of [vault.balance, vault.spent_today, limits.autonomous_limit, limits.hard_cap, limits.daily_cap]) units(v);
      if (!Number.isInteger(limits.decimals) || limits.decimals < 0) throw new Error('Bad decimals');
      return { ...next, started: e.payload };
    }
    case 'AttackStarted':
      return { ...next, attacks: { ...next.attacks, [e.payload.attack]: 'running' } };
    case 'AttackResult':
      return { ...next, attacks: { ...next.attacks, [e.payload.attack]: e.payload } };
    case 'RunCompleted':
      return next;
    case 'MandateUpdated':
    case 'MandateRevoked':
      return { ...next, mandateTxs: [...next.mandateTxs, { type: e.type, version: e.payload.version, txHash: e.payload.tx_hash }] };
  }
  if (e.action_id === null) return { ...next, ignored: next.ignored + 1 };
  const index = next.cards.findIndex((c) => c.actionId === e.action_id);
  const card = index >= 0 ? (next.cards[index] as CardView) : newCard(e.action_id, e.created_at);
  if (e.type === 'ActionProposed' && index >= 0 && card.state !== 'PROPOSED') return { ...next, ignored: next.ignored + 1 };
  const patch = cardPatch(e, card);
  if (patch === null) return { ...next, ignored: next.ignored + 1 };
  const updated = { ...card, ...patch };
  const cards = index >= 0 ? next.cards.map((c, i) => (i === index ? updated : c)) : [...next.cards, updated];
  // Tallied only once the card accepted the event, so a bond event for a card without a bond counts nothing.
  return { ...next, cards, tally: tallied(view.tally, e) };
}

function tallied(t: Tally, e: RunEvent): Tally {
  switch (e.type) {
    case 'ApprovalRequested':
      return { ...t, paged: t.paged + 1 };
    case 'BondRequired':
      return { ...t, bondRequired: t.bondRequired + 1 };
    case 'BondLocked':
      return { ...t, bondLocked: t.bondLocked + 1 };
    case 'BondRefunded':
      return { ...t, bondRefunded: t.bondRefunded + 1 };
    case 'BondCaptured':
      return { ...t, bondCaptured: t.bondCaptured + 1 };
    case 'ActionDenied':
      return e.payload.reason === 'INTERRUPT_BUDGET_EXHAUSTED' ? { ...t, budgetExhausted: t.budgetExhausted + 1 } : t;
    default:
      return t;
  }
}

export const reduceRun = (events: RunEvent[]): RunView => events.reduce(applyEvent, emptyRun());

/** The engine's decision for a card: ESCALATE once a human was asked, else the last evaluation's outcome. Null while undecided. */
export function decisionOf(c: CardView): 'ALLOW' | 'ESCALATE' | 'DENY' | null {
  if (c.approval) return 'ESCALATE';
  if (c.denied?.layer === 'engine' || c.denied?.layer === 'cre') return 'DENY';
  const outcome = c.evaluation?.outcome;
  return outcome === 'ALLOW' || outcome === 'DENY' || outcome === 'ESCALATE' ? outcome : null;
}

/** Was this card denied without paging anyone: the day's interrupt budget was already spent. */
export const budgetExhausted = (c: CardView) => c.denied?.reason === 'INTERRUPT_BUDGET_EXHAUSTED';

/**
 * The same numbers GET /v1/metrics reports, from this view alone (REPLAY, or LIVE while the API is unreachable).
 * `escalate` counts the engine's decisions; interruptions count the humans actually paged, so an escalation that
 * stopped at the 402 or at the budget raises the first and not the second.
 */
export function metricsOf(view: RunView): Metrics {
  const decided = view.cards.map(decisionOf).filter((d): d is 'ALLOW' | 'ESCALATE' | 'DENY' => d !== null);
  const count = (d: 'ALLOW' | 'ESCALATE' | 'DENY') => decided.filter((x) => x === d).length;
  const evaluated = decided.length;
  const escalate = count('ESCALATE');
  const times = view.cards
    .flatMap((c) => (c.approval?.decidedAt ? [Date.parse(c.approval.decidedAt) - Date.parse(c.approval.requestedAt)] : []))
    .sort((a, b) => a - b);
  const mid = times.length >> 1;
  const median = times.length === 0 ? null : times.length % 2 ? (times[mid] as number) : Math.round(((times[mid - 1] as number) + (times[mid] as number)) / 2);
  const t = view.tally;
  return {
    actions_evaluated: evaluated,
    allow: count('ALLOW'),
    deny: count('DENY'),
    escalate,
    interruptions_per_100_actions: evaluated === 0 ? 0 : Math.round((t.paged / evaluated) * 1000) / 10,
    bonds: { required: t.bondRequired, locked: t.bondLocked, refunded: t.bondRefunded, captured: t.bondCaptured },
    budget_exhausted: t.budgetExhausted,
    median_decision_ms: median,
  };
}

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
  if (approval) return { value: 'ESCALATE', tone: 'approval', reason: approval.reason };
  return { value: 'ALLOW', tone: 'pass', reason: null };
}

/** TRUE? row: Chainlink CRE's attestation of the invoice facts. Attributed to CRE: "Verified" is reserved for checks this browser runs. */
export function trueRow(c: CardView): Row {
  if (c.verification) {
    const r = c.verification.report;
    return r.result === 'VERIFIED'
      ? { value: 'Invoice confirmed by Chainlink CRE', tone: 'pass', reason: null }
      : { value: 'MISMATCH', tone: 'fail', reason: r.reason };
  }
  if (c.verifying) return { value: 'Checking with Chainlink CRE…', tone: 'pending', reason: null };
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
  if (c.state === 'ESCALATED' && c.bond?.status === 'required') return { value: 'Waiting for bond', tone: 'approval', reason: null };
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
    case 'ESCALATED':
      return c.approval
        ? { text: 'Escalated to the CFO', tone: 'approval' }
        : { text: 'Escalated. The agent must lock a bond before the CFO is paged', tone: 'approval' };
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
    (sum, c) => ((c.state === 'SETTLED' || c.state === 'PROVEN') && c.authorization ? sum + units(c.authorization.fields.amount) : sum),
    0n,
  );
  return { balance: BigInt(view.started.vault.balance) - settled, spent: BigInt(view.started.vault.spent_today) + settled };
}
