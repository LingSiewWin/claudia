'use client';
import { useMemo, useRef } from 'react';
import type { RunView } from '../../lib/run';
import { type Floor, type Stamps, floorOf, stamp } from './model';

/**
 * RunView -> floor scene. Pure except for the step timestamps, which are stamped with `view.lastAt` the first time a
 * step leaves `pending`: the reducer keeps no per-event history, and lastAt is the created_at of the event just applied.
 */
// ponytail: stamps are per-render; two events applied in one React batch share a timestamp. Store step times in the reducer if that matters.
export function useFloor(view: RunView, selectedId: string | null): Floor {
  const stamps = useRef<Stamps>({});
  if (view.lastSeq === 0) stamps.current = {};
  stamps.current = stamp(stamps.current, view);
  const snapshot = stamps.current;
  return useMemo(() => floorOf(view, selectedId, snapshot), [view, selectedId, snapshot]);
}
