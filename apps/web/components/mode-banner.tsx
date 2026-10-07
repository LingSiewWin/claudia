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
 * One quiet line under the header. LIVE carries a dot; REPLAY carries the browser's own verdict on the stored log
 * (lib/replay.ts replayPlan), never a server claim; `recordedAt` comes from the hashed RunStarted event.
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
      <p data-testid="mode-banner" data-mode="live" className="mode-line">
        <strong>
          <span aria-hidden className="dot" />
          LIVE EXECUTION
        </strong>
        <span>Real transactions on Cardano preprod, as the evidence log records them.</span>
      </p>
    );
  }
  const note = verdict === null ? null : NOTE[verdict];
  return (
    <p data-testid="mode-banner" data-mode="replay" data-verdict={verdict ?? undefined} className="mode-line">
      <strong className={verdict === 'failed' ? 'text-forbid' : undefined}>{banner ?? REPLAY_CHECKING}</strong>
      <span>
        {recordedAt ? `Recorded execution ${recordedAt.slice(0, 10)} ${clock(recordedAt)}. ` : null}
        {note ? `${note} ` : null}No transactions are being submitted.
      </span>
    </p>
  );
}
