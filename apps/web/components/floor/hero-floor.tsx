'use client';
import { useEffect, useState } from 'react';
import { useReplay } from '../../lib/hooks';
import { metricsOf } from '../../lib/run';
import { FloorStage } from './floor-stage';

/** The recorded run the landing floor replays: an agent spams escalations, loses three bonds, then hits the budget. */
const HERO_RUN = 'run-lab-escalation_spam';
const LOOP_PAUSE_MS = 5000;

/** Landing hero: the recorded escalation-spam run on the floor, hash-checked in the browser, looping. */
export function HeroFloor() {
  const [loop, setLoop] = useState(0);
  return <Replay key={loop} onDone={() => setLoop((n) => n + 1)} />;
}

function Replay({ onDone }: { onDone: () => void }) {
  const { view, recordedAt, verdict, banner, done, error } = useReplay(HERO_RUN);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(onDone, LOOP_PAUSE_MS);
    return () => clearTimeout(id);
  }, [done, onDone]);
  return (
    <FloorStage view={view} metrics={metricsOf(view)} source="replay" now={view.lastAt ? Date.parse(view.lastAt) : 0} detail={false}>
      <p data-testid="mode-banner" data-mode="replay" data-verdict={verdict ?? undefined} className="floor-glass max-w-[21rem] px-3 py-2 text-[12px] leading-snug">
        <span className={`block font-extrabold tracking-wide ${verdict === 'failed' ? 'text-forbid' : ''}`}>{error ? 'The recorded run is unavailable right now.' : (banner ?? 'REPLAY — CHECKING HISTORICAL RUN…')}</span>
        <span className="text-muted">
          {recordedAt ? `Recorded ${recordedAt.slice(0, 10)}. ` : ''}Every event hash recomputes in your browser. No transactions are being submitted.
        </span>
      </p>
    </FloorStage>
  );
}
