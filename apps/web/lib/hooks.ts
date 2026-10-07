'use client';
import { useEffect, useRef, useState } from 'react';
import { eventsUrl, runLog } from './api';
import { koiosTx } from './chain';
import { config } from './config';
import type { RunEvent } from './contract';
import { type ReplayVerdict, readAnchor, replayPlan, unanchoredActions } from './replay';
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
  /** From the hashed RunStarted event, never from the run summary. */
  recordedAt: string | null;
  done: boolean;
  /** The browser's own verdict on the stored log (lib/replay.ts); null while loading. */
  verdict: ReplayVerdict | null;
  banner: string | null;
  /** Actions with evidence after the on-chain anchor. */
  unanchored: ReadonlySet<string>;
  error: string | null;
  skip: () => void;
}

const ANCHOR_TIMEOUT_MS = 8_000;
const NONE: ReadonlySet<string> = new Set();
const TX_HASH = /^[0-9a-f]{64}$/;

/**
 * REPLAY: one request for the stored log, chain reads for its on-chain log head (closing anchor, else the latest
 * settlement), the hash check in this browser, then local playback at stage speed. No other network.
 */
export function useReplay(runId: string | null): ReplayState {
  const [view, setView] = useState<RunView>(emptyRun);
  const [recordedAt, setRecordedAt] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [verdict, setVerdict] = useState<ReplayVerdict | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [unanchored, setUnanchored] = useState<ReadonlySet<string>>(NONE);
  const [error, setError] = useState<string | null>(null);
  const eventsRef = useRef<RunEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setView(emptyRun());
    setRecordedAt(null);
    setDone(false);
    setVerdict(null);
    setBanner(null);
    setUnanchored(NONE);
    setError(null);
    eventsRef.current = [];
    if (runId === null) return;
    let cancelled = false;
    let anchorTimer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const { events, anchor: ref } = await runLog(runId);
      if (cancelled) return;
      const closingTx = typeof ref?.tx_hash === 'string' && TX_HASH.test(ref.tx_hash) ? ref.tx_hash : null;
      const anchor = await Promise.race([
        readAnchor(events, koiosTx, closingTx),
        new Promise<null>((resolve) => {
          anchorTimer = setTimeout(() => resolve(null), ANCHOR_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(anchorTimer);
      if (cancelled) return;
      // Which run opens the evidence chain is the client's own constant, never a field of the server's response.
      const plan = replayPlan(events, anchor, runId === config.stageRunId, runId);
      setRecordedAt(plan.recordedAt);
      setVerdict(plan.verdict);
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
      clearTimeout(anchorTimer);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [runId]);

  const skip = () => {
    if (timer.current) clearTimeout(timer.current);
    setView(reduceRun(eventsRef.current));
    setDone(true);
  };
  return { view, recordedAt, done, verdict, banner, unanchored, error, skip };
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
