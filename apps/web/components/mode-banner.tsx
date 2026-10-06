import { clock } from '../lib/format';
import type { ReplayVerdict } from '../lib/replay';

export type Mode = 'live' | 'replay';

const REPLAY_CHECKING = 'REPLAY — CHECKING HISTORICAL RUN…';
/** What each verdict can honestly claim. */
const NOTE: Record<ReplayVerdict, string> = {
  verified: 'All evidence is from a real execution.',
  through: 'Earlier events match the log head committed on Cardano; later actions are marked not anchored.',
  unanchored: 'Every event hash recomputes in this browser, but no on-chain log head was read to anchor it.',
  failed: 'The stored log does not match its hashes, its run, or the log head committed on Cardano. Nothing is replayed.',
};

/**
 * LIVE is a small ink pill with a static dot. REPLAY is a hatched tape banner that cannot be mistaken for it.
 * `verdict` and `banner` are the browser's own check of the stored log (lib/replay.ts replayPlan), never a server
 * claim; `recordedAt` comes from the hashed RunStarted event.
 */
export function ModeBanner({
  mode,
  recordedAt,
  verdict = null,
  banner = null,
}: {
  mode: Mode;
  recordedAt: string | null;
  verdict?: ReplayVerdict | null;
  banner?: string | null;
}) {
  if (mode === 'live') {
    return (
      <p data-testid="mode-banner" data-mode="live" className="inline-flex items-center gap-2 rounded-full bg-ink px-3 py-1 text-sm font-bold text-mist">
        <span aria-hidden className="size-2 rounded-full bg-mist" />
        LIVE EXECUTION
      </p>
    );
  }
  const note = verdict === null ? null : NOTE[verdict];
  return (
    <div data-testid="mode-banner" data-mode="replay" data-verdict={verdict ?? undefined} className="replay-hatch rounded-[10px] border border-line px-4 py-3 text-fg">
      <p className={`font-extrabold tracking-wide ${verdict === 'failed' ? 'text-forbid' : ''}`}>{banner ?? REPLAY_CHECKING}</p>
      <p className="mt-1 text-[15px]">
        {recordedAt ? `Recorded execution ${recordedAt.slice(0, 10)} ${clock(recordedAt)}. ` : null}
        {note ? `${note} ` : null}No transactions are being submitted.
      </p>
    </div>
  );
}
