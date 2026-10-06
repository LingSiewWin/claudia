import { canonicalJson, concatBytes, hexToBytes, sha256Hex, utf8ToBytes } from '@authority/core';
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

/**
 * What earns REPLAY its "VERIFIED" label: every stored event's hash recomputes in this browser
 * (sha256(prev_hash || RFC 8785 body)) and every event links to its predecessor with no gap in sequence numbers.
 */
export function logIntact(events: RunEvent[]): boolean {
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
export const REPLAY_FAILED = 'REPLAY — EVIDENCE LOG FAILED VERIFICATION';

/** What REPLAY plays: the "VERIFIED" banner is earned by logIntact; a log that fails it plays nothing. */
export function replayPlan(events: RunEvent[]): { verified: boolean; banner: string; events: RunEvent[]; delays: number[] } {
  if (!logIntact(events)) return { verified: false, banner: REPLAY_FAILED, events: [], delays: [] };
  return { verified: true, banner: REPLAY_VERIFIED, events, delays: replayDelays(events) };
}
