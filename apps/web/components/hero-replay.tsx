'use client';
import { listRuns } from '../lib/api';
import { useLoad, useReplay } from '../lib/hooks';
import { ActionCard } from './action-card';
import { ModeBanner } from './mode-banner';

/** Landing hero: the first action of the latest recorded stage run, replayed under the REPLAY banner. */
export function HeroReplay() {
  const runs = useLoad(() => listRuns('stage'), []);
  const runId = runs.data?.runs[0]?.run_id ?? null;
  const { view, recordedAt, verdict, banner, error } = useReplay(runId);
  const card = view.cards[0];
  return (
    <div data-mode="replay" className="space-y-3 rounded-[14px] bg-surface p-3 text-fg">
      <ModeBanner mode="replay" recordedAt={recordedAt} verdict={verdict} banner={banner} />
      {card ? (
        <ActionCard card={card} started={view.started} now={view.lastAt ? Date.parse(view.lastAt) : 0} />
      ) : (
        <p className="p-6 text-muted">{runs.error || error ? 'The recorded run is unavailable right now.' : 'Loading a recorded run…'}</p>
      )}
    </div>
  );
}
