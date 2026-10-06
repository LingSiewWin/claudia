'use client';
import { useEffect, useRef, useState } from 'react';
import { eventsUrl, runLog } from './api';
import { koiosTx } from './chain';
import { config } from './config';
import type { RunEvent, RunSummary } from './contract';
import { readAnchor, replayPlan, unanchoredActions } from './replay';
import { type RunView, applyEvent, emptyRun, reduceRun } from './run';

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

/** LIVE: renders only the SSE event stream. EventSource resumes with Last-Event-ID after a drop. */
export function useEventStream(runId: string | null): { view: RunView; status: StreamStatus } {
  const [view, setView] = useState<RunView>(emptyRun);
  const [status, setStatus] = useState<StreamStatus>('idle');
  useEffect(() => {
    setView(emptyRun());
    if (runId === null) {
      setStatus('idle');
      return;
    }
    setStatus('connecting');
    const source = new EventSource(eventsUrl(runId));
    source.onopen = () => setStatus('open');
    source.onerror = () => setStatus('reconnecting');
    source.onmessage = (message: MessageEvent<string>) => {
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return; // a corrupt frame is dropped; the reducer flags the resulting gap
      }
      setView((v) => applyEvent(v, event));
    };
    return () => source.close();
  }, [runId]);
  return { view, status };
}

export interface ReplayState {
  view: RunView;
  run: RunSummary | null;
  done: boolean;
  /** The browser's own verdict on the stored log (lib/replay.ts); null while loading. */
  banner: string | null;
  /** Actions with evidence after the on-chain anchor. */
  unanchored: ReadonlySet<string>;
  error: string | null;
  skip: () => void;
}

const ANCHOR_TIMEOUT_MS = 8_000;
const NONE: ReadonlySet<string> = new Set();

/**
 * REPLAY: one request for the stored log, one chain read for its on-chain log head, the hash check in this browser,
 * then local playback at stage speed. No other network.
 */
export function useReplay(runId: string | null): ReplayState {
  const [view, setView] = useState<RunView>(emptyRun);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [done, setDone] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [unanchored, setUnanchored] = useState<ReadonlySet<string>>(NONE);
  const [error, setError] = useState<string | null>(null);
  const eventsRef = useRef<RunEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setView(emptyRun());
    setRun(null);
    setDone(false);
    setBanner(null);
    setUnanchored(NONE);
    setError(null);
    eventsRef.current = [];
    if (runId === null) return;
    let cancelled = false;
    const load = async () => {
      const { run: summary, events } = await runLog(runId);
      if (cancelled) return;
      setRun(summary);
      const anchor = await Promise.race([
        readAnchor(events, koiosTx),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ANCHOR_TIMEOUT_MS)),
      ]);
      if (cancelled) return;
      // Which run opens the evidence chain is the client's own constant, never a field of the server's response.
      const plan = replayPlan(events, anchor, runId === config.stageRunId);
      setBanner(plan.banner);
      setUnanchored(unanchoredActions(plan.events, plan.anchoredThrough));
      eventsRef.current = plan.events;
      let i = 0;
      const step = () => {
        const event = plan.events[i];
        if (cancelled || event === undefined) {
          setDone(true);
          return;
        }
        setView((v) => applyEvent(v, event));
        i += 1;
        timer.current = setTimeout(step, plan.delays[i] ?? 0);
      };
      step();
    };
    load().catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [runId]);

  const skip = () => {
    if (timer.current) clearTimeout(timer.current);
    setView(reduceRun(eventsRef.current));
    setDone(true);
  };
  return { view, run, done, banner, unanchored, error, skip };
}

/** Wall clock that ticks once a second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Minimal JSON loader with reload. */
export function useLoad<T>(load: (() => Promise<T>) | null, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (load === null) return;
    let cancelled = false;
    load().then(
      (d) => !cancelled && (setData(d), setError(null)),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}
