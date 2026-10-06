import { canonicalJson, concatBytes, hexToBytes, sha256Hex, utf8ToBytes } from '@authority/core';
import type { KoiosTx } from './chain';
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

/** The log head committed on-chain in the settlement transaction metadata (log_head), read by the browser itself. */
export interface LogAnchor {
  seq: number;
  head: string;
}

export interface ReplayPlan {
  verified: boolean;
  banner: string;
  events: RunEvent[];
  delays: number[];
  /** Last seq covered by the on-chain anchor; events after it play but are not proven. Null when unanchored. */
  anchoredThrough: number | null;
}

/**
 * What REPLAY plays. VERIFIED needs an internally consistent log AND the on-chain anchor matching the event at
 * anchor.seq; an anchor short of the last event says how far it reaches. Consistent but unanchored plays under a
 * weaker banner. Anything inconsistent, or an anchor that disagrees, plays nothing.
 */
export function replayPlan(events: RunEvent[], anchor: LogAnchor | null = null, startsChain = true): ReplayPlan {
  const failed = { verified: false, banner: REPLAY_FAILED, events: [], delays: [], anchoredThrough: null };
  if (!logIntact(events, startsChain)) return failed;
  const play = { events, delays: replayDelays(events) };
  if (!anchor) return { verified: false, banner: REPLAY_UNANCHORED, ...play, anchoredThrough: null };
  if (events.find((e) => e.seq === anchor.seq)?.hash !== anchor.head) return failed;
  const whole = anchor.seq === events[events.length - 1]?.seq;
  return { verified: true, banner: whole ? REPLAY_VERIFIED : replayVerifiedThrough(anchor.seq), ...play, anchoredThrough: anchor.seq };
}

/**
 * The log head the run's latest settlement committed on Cardano (metadata label 1694, `log_head`), from chain data the
 * browser reads itself. `{ seq, hash }` names its event; a bare hash is the head at that settlement's
 * TransactionConfirmed event. A chain that does not answer, or metadata without a head, is no anchor, never a pass.
 */
export async function readAnchor(events: RunEvent[], read: (txHash: string) => Promise<KoiosTx | null>): Promise<LogAnchor | null> {
  const settled = events.findLast((e) => e.type === 'TransactionConfirmed');
  if (settled?.type !== 'TransactionConfirmed') return null;
  let head: unknown;
  try {
    head = ((await read(settled.payload.tx_hash))?.metadata?.['1694'] as { log_head?: unknown } | undefined)?.log_head;
  } catch {
    return null;
  }
  if (typeof head === 'string') return { seq: settled.seq, head };
  const named = head as { seq?: unknown; hash?: unknown } | null | undefined;
  if (typeof named?.seq === 'number' && Number.isInteger(named.seq) && typeof named.hash === 'string') return { seq: named.seq, head: named.hash };
  return null;
}

/** Actions with any event after the anchored head: their outcome is not covered by the on-chain anchor. */
export function unanchoredActions(events: RunEvent[], anchoredThrough: number | null): Set<string> {
  if (anchoredThrough === null) return new Set();
  return new Set(events.flatMap((e) => (e.action_id !== null && e.seq > anchoredThrough ? [e.action_id] : [])));
}
