import { canonicalJson, concatBytes, hexToBytes, sha256Hex, utf8ToBytes, verifyEvidenceAnchor } from '@authority/core';
import { MANDATE_TOKEN_HEX, bytesOf, field, type KoiosTx } from './chain';
import type { RunEvent } from './contract';

/** Delay in ms before each event when replaying at stage speed: recorded gaps clamped to [min, max]. */
export function replayDelays(events: RunEvent[], min = 250, max = 1400): number[] {
  return events.map((e, i) => {
    const prev = events[i - 1];
    if (!prev) return 0;
    const gap = Date.parse(e.created_at) - Date.parse(prev.created_at);
    return Math.min(max, Math.max(min, Number.isFinite(gap) ? gap : min));
  });
}

const GENESIS = '00'.repeat(32);

/**
 * Internal consistency only: every stored event's hash recomputes in this browser
 * (sha256(prev_hash || RFC 8785 body)), every event links to its predecessor with no gap in sequence
 * numbers, and a log that claims to start the chain begins at seq 1 on the genesis value.
 * Hashes are unkeyed, so a forger can make an edited chain consistent: only an anchor makes it evidence.
 * Pass startsChain = false for a run that begins mid-chain.
 */
export function logIntact(events: RunEvent[], startsChain = true): boolean {
  const first = events[0];
  if (!first) return false;
  if (startsChain && (first.seq !== 1 || first.prev_hash !== GENESIS)) return false;
  return events.every((e, i) => {
    const { hash, prev_hash, ...body } = e;
    const prev = events[i - 1];
    if (prev && (prev.seq + 1 !== e.seq || prev.hash !== prev_hash)) return false;
    try {
      return sha256Hex(concatBytes(hexToBytes(prev_hash), utf8ToBytes(canonicalJson(body)))) === hash;
    } catch {
      return false;
    }
  });
}

export const REPLAY_VERIFIED = 'REPLAY — VERIFIED HISTORICAL RUN';
export const REPLAY_UNANCHORED = 'REPLAY — RECORDED RUN · INTEGRITY CHECKED, NOT ANCHORED';
export const REPLAY_FAILED = 'REPLAY — EVIDENCE LOG FAILED VERIFICATION';
export const replayVerifiedThrough = (seq: number) => `REPLAY — VERIFIED THROUGH EVENT ${seq} · LATER EVENTS NOT ANCHORED`;

/** A log head committed on Cardano (metadata 1694 `log_head`), read by the browser itself. */
export interface LogAnchor {
  seq: number;
  head: string;
}

export type ReplayVerdict = 'verified' | 'through' | 'unanchored' | 'failed';

export interface ReplayPlan {
  verdict: ReplayVerdict;
  verified: boolean;
  banner: string;
  events: RunEvent[];
  delays: number[];
  /** Last seq covered by the on-chain anchor; events after it play but are not proven. Null when unanchored. */
  anchoredThrough: number | null;
  /** created_at of the hashed RunStarted event; null when nothing plays. */
  recordedAt: string | null;
}

/** Events that close a run: the last action's outcome, or an Attack Lab result. */
const TERMINAL = new Set<RunEvent['type']>(['ReceiptProven', 'ActionDenied', 'CFODeclined', 'TransactionRejected', 'AttackResult']);

/**
 * What REPLAY plays, for the run the browser asked for. The log must be internally consistent, start with RunStarted,
 * and belong to `runId` in every event; otherwise nothing plays. VERIFIED needs the on-chain anchor to match the event
 * at anchor.seq, and to be the last event of a run that ended; a shorter anchor says how far it reaches. Consistent but
 * unanchored plays under a weaker banner. An anchor that disagrees plays nothing.
 */
export function replayPlan(events: RunEvent[], anchor: LogAnchor | null = null, startsChain = true, runId = events[0]?.run_id): ReplayPlan {
  const failed: ReplayPlan = { verdict: 'failed', verified: false, banner: REPLAY_FAILED, events: [], delays: [], anchoredThrough: null, recordedAt: null };
  const first = events[0];
  if (!logIntact(events, startsChain) || first?.type !== 'RunStarted' || events.some((e) => e.run_id !== runId)) return failed;
  const play = { events, delays: replayDelays(events), recordedAt: first.created_at };
  if (!anchor) return { verdict: 'unanchored', verified: false, banner: REPLAY_UNANCHORED, ...play, anchoredThrough: null };
  if (events.find((e) => e.seq === anchor.seq)?.hash !== anchor.head) return failed;
  const last = events[events.length - 1] as RunEvent;
  const whole = anchor.seq === last.seq && TERMINAL.has(last.type);
  return whole
    ? { verdict: 'verified', verified: true, banner: REPLAY_VERIFIED, ...play, anchoredThrough: anchor.seq }
    : { verdict: 'through', verified: true, banner: replayVerifiedThrough(anchor.seq), ...play, anchoredThrough: anchor.seq };
}

type ReadTx = (txHash: string) => Promise<KoiosTx | null>;

function namedHead(head: unknown): LogAnchor | null {
  const named = head as { seq?: unknown; hash?: unknown } | null | undefined;
  return typeof named?.seq === 'number' && Number.isInteger(named.seq) && typeof named.hash === 'string'
    ? { seq: named.seq, head: named.hash }
    : null;
}

/** Policies named by this run's authorizations. A closing anchor binds only when exactly one is named. */
function mandatePolicies(events: RunEvent[]): string[] {
  return [...new Set(events.flatMap((e) => (e.type === 'AuthorizationIssued' ? [e.payload.authorization.fields.mandate_ref] : [])))];
}

/**
 * Engine verification key from the mandate datum.
 * The reference input must carry the mandate token under the policy the run's authorizations name,
 * the same match receipt verification uses. A mandate-named token on another policy does not supply the key.
 */
function engineVkey(tx: KoiosTx, policyId: string): string | null {
  const utxo = tx.reference_inputs.find((u) =>
    u.asset_list.some((x) => x.asset_name === MANDATE_TOKEN_HEX && x.policy_id === policyId),
  );
  return bytesOf(field(utxo?.inline_datum?.value, 3));
}

/** metadata 1694 `log_head` in its only valid form, `{ seq, hash }`. A bare hash, or no answer, is no head. */
async function committedHead(read: ReadTx, txHash: string): Promise<LogAnchor | null> {
  let head: unknown;
  try {
    head = ((await read(txHash))?.metadata?.['1694'] as { log_head?: unknown } | undefined)?.log_head;
  } catch {
    return null;
  }
  return namedHead(head);
}

/**
 * A closing anchor is only a closing anchor when metadata 1694 carries a valid engine signature over
 * EVIDENCE_ANCHOR_V1 || run_id || seq || hash, checked against engine_vkey in the on-chain mandate datum
 * of the policy the run's authorizations name. Unsigned or invalid is no closing anchor.
 */
async function signedClosingHead(read: ReadTx, txHash: string, runId: string, policyId: string): Promise<LogAnchor | null> {
  let tx: KoiosTx | null;
  try {
    tx = await read(txHash);
  } catch {
    return null;
  }
  if (!tx) return null;
  const meta = tx.metadata?.['1694'] as { log_head?: unknown; signature?: unknown } | undefined;
  const head = namedHead(meta?.log_head);
  if (!head || typeof meta?.signature !== 'string') return null;
  const key = engineVkey(tx, policyId);
  return key && verifyEvidenceAnchor(runId, head.seq, head.head, meta.signature, key) ? head : null;
}

/**
 * The on-chain anchor for a run, from chain data the browser reads itself. First the run's closing anchor
 * (`closingTx`, a pointer from the API: only the head read from chain counts). Failing that, the latest settlement
 * named in the log, whose head must be an event from before that transaction was submitted (a transaction cannot
 * commit a head that names itself). No answer or no valid head is no anchor, never a pass.
 */
export async function readAnchor(events: RunEvent[], read: ReadTx, closingTx: string | null = null): Promise<LogAnchor | null> {
  const runId = events[0]?.run_id;
  const policies = mandatePolicies(events);
  const policyId = policies.length === 1 ? policies[0] : undefined;
  if (closingTx && runId && policyId) {
    const closing = await signedClosingHead(read, closingTx, runId, policyId);
    if (closing) return closing;
  }
  const settled = events.findLast((e) => e.type === 'TransactionConfirmed');
  if (settled?.type !== 'TransactionConfirmed') return null;
  const tx = settled.payload.tx_hash;
  const submitted = events.find((e) => e.type === 'TransactionSubmitted' && e.payload.tx_hash === tx);
  const head = await committedHead(read, tx);
  return head && submitted && head.seq < submitted.seq ? head : null;
}

/** Actions with any event after the anchored head: their outcome is not covered by the on-chain anchor. */
export function unanchoredActions(events: RunEvent[], anchoredThrough: number | null): Set<string> {
  if (anchoredThrough === null) return new Set();
  return new Set(events.flatMap((e) => (e.action_id !== null && e.seq > anchoredThrough ? [e.action_id] : [])));
}
