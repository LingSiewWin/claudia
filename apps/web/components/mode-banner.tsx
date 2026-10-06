import { clock } from '../lib/format';
import { REPLAY_FAILED, REPLAY_UNANCHORED, REPLAY_VERIFIED } from '../lib/replay';

export type Mode = 'live' | 'replay';

const REPLAY_CHECKING = 'REPLAY — CHECKING HISTORICAL RUN…';
/** What each verdict can honestly claim; the partial ("VERIFIED THROUGH EVENT n") banner falls through to PARTIAL. */
const NOTE: Record<string, string> = {
  [REPLAY_VERIFIED]: 'All evidence is from a real execution.',
  [REPLAY_UNANCHORED]: 'Every event hash recomputes in this browser, but no on-chain log head was read to anchor it.',
  [REPLAY_FAILED]: 'The stored log does not match its hashes or the log head committed on Cardano. Nothing is replayed.',
};
const PARTIAL = 'Earlier events match the log head committed on Cardano; later actions are marked not anchored.';

/**
 * LIVE is a small ink pill with a static dot. REPLAY is a hatched tape banner that cannot be mistaken for it.
 * `banner` is the browser's own verdict on the stored log (lib/replay.ts replayPlan), never a server claim.
 */
export function ModeBanner({ mode, recordedAt, banner = null }: { mode: Mode; recordedAt: string | null; banner?: string | null }) {
  if (mode === 'live') {
    return (
      <p data-testid="mode-banner" data-mode="live" className="inline-flex items-center gap-2 rounded-full bg-ink px-3 py-1 text-sm font-bold text-mist">
        <span aria-hidden className="size-2 rounded-full bg-mist" />
        LIVE EXECUTION
      </p>
    );
  }
  const note = banner === null ? null : (NOTE[banner] ?? PARTIAL);
  return (
    <div data-testid="mode-banner" data-mode="replay" className="replay-hatch rounded-[10px] border border-line px-4 py-3 text-fg">
      <p className={`font-extrabold tracking-wide ${banner === REPLAY_FAILED ? 'text-forbid' : ''}`}>{banner ?? REPLAY_CHECKING}</p>
      <p className="mt-1 text-[15px]">
        Recorded execution {recordedAt ? `${recordedAt.slice(0, 10)} ${clock(recordedAt)}` : '…'}. {note ? `${note} ` : null}No
        transactions are being submitted.
      </p>
    </div>
  );
}
