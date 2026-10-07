'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { getMandate, getMetrics, listRuns, startRun } from '../lib/api';
import { config } from '../lib/config';
import type { Limits, MandateView, RunSummary } from '../lib/contract';
import { clock, money, actionTitle } from '../lib/format';
import { useEventStream, useLoad, useNow, useReplay } from '../lib/hooks';
import { type CardView, type RunView, metricsOf, statusLine, treasury, units } from '../lib/run';
import { ActionCard, ActionDetail } from './action-card';
import { FloorStage } from './floor/floor-stage';
import { ATTACKS, AttackLab, AttackTileBody } from './attack-lab';
import { BoundaryRail } from './boundary-rail';
import { type Mode, ModeBanner } from './mode-banner';
import './live.css';

const DESKTOP = 1024;

export function LiveTheater({ initialMode, initialRun }: { initialMode: Mode; initialRun: string | null }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [liveRun, setLiveRun] = useState<string | null>(initialMode === 'live' ? initialRun : null);
  const [replayRun, setReplayRun] = useState<string | null>(initialMode === 'replay' ? initialRun : null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const stageRef = useRef<HTMLOListElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const live = useEventStream(mode === 'live' ? liveRun : null);
  const mandate = useLoad(mode === 'live' ? () => getMandate(config.stageMandateId).then(fromMandate) : null, [mode]);
  const runs = useLoad(mode === 'replay' ? () => listRuns('all') : null, [mode]);
  const replay = useReplay(mode === 'replay' ? replayRun : null);

  useEffect(() => {
    const first = runs.data?.runs.find((r) => r.kind === 'stage') ?? runs.data?.runs[0];
    if (mode === 'replay' && replayRun === null && first) setReplayRun(first.run_id);
  }, [mode, replayRun, runs.data]);

  useEffect(() => {
    const run = mode === 'live' ? liveRun : replayRun;
    const q = new URLSearchParams({ mode, ...(run ? { run } : {}) });
    window.history.replaceState(null, '', `/live?${q.toString()}`);
  }, [mode, liveRun, replayRun]);

  // Cards snap to the viewport centre while this page is mounted.
  useEffect(() => {
    document.documentElement.classList.add('live-snap');
    return () => document.documentElement.classList.remove('live-snap');
  }, []);

  const view: RunView = mode === 'live' ? live.view : replay.view;
  const runKey = mode === 'live' ? liveRun : replayRun;
  useEffect(() => setSelected(null), [mode, runKey]);

  // The newest card takes the stage unless the reader has already picked another one.
  const lastId = view.cards.at(-1)?.actionId ?? null;
  const prevLast = useRef<string | null>(null);
  useEffect(() => {
    if (lastId !== null && (selected === null || selected === prevLast.current)) setSelected(lastId);
    prevLast.current = lastId;
  }, [lastId]);

  // Scrolling hands the stage to the card crossing the viewport centre.
  useEffect(() => {
    const cards = Array.from(stageRef.current?.querySelectorAll<HTMLElement>('[data-testid=action-card]') ?? []);
    if (cards.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const id = hit?.target.getAttribute('data-action-id');
        if (id) setSelected(id);
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
    );
    for (const c of cards) io.observe(c);
    return () => io.disconnect();
  }, [view.cards.length]);

  const select = (id: string) => {
    setSelected(id);
    if (window.innerWidth < DESKTOP) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      panelRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
  };

  // LIVE: the mandate-wide numbers from the API, refetched each time a card reaches an outcome. REPLAY: this run's own.
  const settledCount = view.cards.filter((c) => ['PROVEN', 'DENIED', 'SETTLED'].includes(c.state)).length;
  const apiMetrics = useLoad(mode === 'live' ? () => getMetrics(config.stageMandateId) : null, [mode, liveRun, settledCount]);
  const executing = view.cards.some((c) => c.state === 'EXECUTING');
  const wall = useNow(mode === 'live' && executing);
  const now = mode === 'live' ? wall : view.lastAt ? Date.parse(view.lastAt) : 0;
  // Until the run's own RunStarted arrives, LIVE shows the mandate as the vault holds it now.
  const authority = fromRun(view) ?? (mode === 'live' ? mandate.data : null);
  const problem = error ?? (mode === 'live' ? mandate.error : (runs.error ?? replay.error));

  const run = async () => {
    setStarting(true);
    setError(null);
    try {
      setLiveRun((await startRun(config.stageMandateId)).run_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const metrics = mode === 'live' ? apiMetrics.data : metricsOf(view);
  const source = mode === 'live' ? (apiMetrics.data ? 'api' : 'none') : 'replay';
  const allRuns = runs.data?.runs ?? [];
  const labs = ATTACKS.flatMap((a) => allRuns.filter((r) => r.kind === 'lab' && r.attack === a.id));
  const onLab = mode === 'replay' && labs.some((r) => r.run_id === replayRun);
  const selectedIndex = view.cards.findIndex((c) => c.actionId === selected);
  const selectedCard: CardView | null = selectedIndex >= 0 ? (view.cards[selectedIndex] ?? null) : null;

  return (
    <div data-mode={mode} className="live min-h-dvh">
      <div className="mx-auto max-w-7xl px-5">
        <header className="live-head">
          <div role="radiogroup" aria-label="Mode" className="seg">
            {(['live', 'replay'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
                {m === 'live' ? 'LIVE EXECUTION' : 'REPLAY'}
              </button>
            ))}
          </div>
          {mode === 'live' ? (
            <button type="button" className="btn btn-primary" onClick={run} disabled={starting}>
              {starting ? 'Starting…' : liveRun ? 'Run the agent again' : 'Run the agent'}
            </button>
          ) : (
            <RunPicker runs={allRuns} value={replayRun} onChange={setReplayRun} />
          )}
          <span className="flex-1" />
          <Link href="/" className="text-sm font-semibold text-heading">
            Claudia
          </Link>
        </header>

        <ModeBanner
          mode={mode}
          recordedAt={mode === 'replay' ? replay.recordedAt : null}
          verdict={mode === 'replay' ? replay.verdict : null}
          banner={mode === 'replay' ? replay.banner : null}
        />

        <div className="mt-2">
          <FloorStage view={view} metrics={metrics} source={source} now={now} mode={mode} />
        </div>
        {mode === 'replay' && !replay.done && view.cards.length > 0 ? (
          <button type="button" className="btn-quiet mt-3" onClick={replay.skip}>
            Skip to the end
          </button>
        ) : null}

        {onLab ? (
          <section aria-label="Attacks" className="mt-8">
            <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">
              Attacks · recorded attempts on the lab treasury, each stopped with no funds moved
            </h2>
            <ul className="attack-grid attack-grid-wide mt-3">
              {labs.map((r) => {
                const spec = ATTACKS.find((a) => a.id === r.attack);
                if (!spec) return null;
                return (
                  <li key={r.run_id} className="grid">
                    <button
                      type="button"
                      className="attack-tile"
                      aria-pressed={r.run_id === replayRun}
                      title={`Recorded ${r.started_at.slice(0, 10)} ${clock(r.started_at)}`}
                      onClick={() => setReplayRun(r.run_id)}
                    >
                      <AttackTileBody a={spec} />
                      <span className="mt-auto font-mono text-[11px] text-muted">{r.started_at.slice(0, 10)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="mx-auto grid max-w-7xl gap-8 px-5 pb-16 pt-10 lg:grid-cols-12">
        <section aria-label="Agent actions" className="min-w-0 lg:col-span-7">
          <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">Log</h2>
          {authority ? <AuthorityHeader a={authority} /> : null}

          {problem ? (
            <p role="alert" className="mt-4 text-forbid">
              {problem}
            </p>
          ) : null}

          {mode === 'live' && liveRun === null ? (
            <p className="mt-8 max-w-prose text-lg text-muted">
              Start CFO-Agent-01 on today&apos;s open invoices. Every step below comes from the evidence log as it
              happens.
            </p>
          ) : null}
          {mode === 'live' && live.status === 'reconnecting' ? (
            <p className="mt-4 text-sm text-muted">Connection dropped. Resuming from the last event…</p>
          ) : null}
          {mode === 'live' && live.view.gap ? (
            <p className="mt-4 text-sm text-muted">Some events of this run were missed. Reload the page to rebuild it from the log.</p>
          ) : null}

          <ol ref={stageRef} className="stage mt-6">
            {view.cards.map((card, i) => (
              <li key={card.actionId} className="stage-slot">
                <ActionCard
                  card={card}
                  started={view.started}
                  now={now}
                  index={{ n: i + 1, of: view.cards.length }}
                  unanchored={mode === 'replay' && replay.unanchored.has(card.actionId)}
                  selected={selected === card.actionId}
                  onSelect={select}
                />
              </li>
            ))}
          </ol>
        </section>

        <aside ref={panelRef} aria-label="Detail" className="min-w-0 lg:col-span-5">
          <div className="panel-sticky grid gap-4">
            {selectedCard ? (
              <DetailPanel card={selectedCard} n={selectedIndex + 1} of={view.cards.length} started={view.started} now={now} />
            ) : view.cards.length > 0 ? (
              <div className="panel p-5 text-sm text-muted">Scroll the log. The action on stage opens here.</div>
            ) : null}
            {mode === 'live' ? (
              <div className="panel p-5">
                <AttackLab />
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** The action on stage, in full: outcome, brief, the three questions, the chain. */
function DetailPanel({ card, n, of, started, now }: { card: CardView; n: number; of: number; started: RunView['started']; now: number }) {
  const a = card.action;
  const amount = a?.amount.value ?? card.authorization?.fields.amount ?? null;
  const decimals = started?.limits.decimals ?? 6;
  const status = statusLine(card);
  return (
    <div data-testid="detail" data-action-id={card.actionId} className="panel p-5">
      <p className="stage-index">
        On stage · {String(n).padStart(2, '0')} / {String(of).padStart(2, '0')}
      </p>
      <div className="mt-1 flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-bold leading-tight">{a ? actionTitle(a) : 'Payment outside the mandate'}</h2>
        <p className="text-xl font-extrabold tabular-nums text-heading">{amount === null ? '—' : money(amount, decimals)}</p>
      </div>
      <p className="mt-1 text-sm font-semibold text-fg">{status.text}</p>
      <div className="mt-4">
        <ActionDetail card={card} started={started} now={now} />
      </div>
    </div>
  );
}

/** Whose authority, over how much money: from the run's RunStarted, or from the mandate before a run. */
interface Authority {
  principal: string;
  delegate: string;
  mandate: string;
  limits: Limits;
  balance: bigint;
  spent: bigint;
  revoked: boolean;
  goal: string | null;
}

function fromRun(view: RunView): Authority | null {
  const s = view.started;
  const t = treasury(view);
  if (!s || !t) return null;
  const mandate = `${s.mandate_id} v${s.mandate_version}`;
  return { principal: s.principal, delegate: s.delegate, mandate, limits: s.limits, balance: t.balance, spent: t.spent, revoked: false, goal: s.goal };
}

/** Throws on a malformed amount, so a bad API response shows as an error instead of breaking the page. */
function fromMandate(m: MandateView): Authority {
  const { limits, vault } = m;
  for (const v of [limits.autonomous_limit, limits.hard_cap, limits.daily_cap]) units(v);
  if (!Number.isInteger(limits.decimals) || limits.decimals < 0) throw new Error('Bad decimals');
  return {
    principal: m.mandate.principal.name,
    delegate: m.mandate.delegate.id,
    mandate: `${m.mandate.id} v${m.mandate.version}`,
    limits,
    balance: units(vault.balance),
    spent: units(vault.spent_today),
    revoked: m.anchor.status === 'revoked',
    goal: null,
  };
}

/** Company money first: whose authority, the treasury, today's spend against the cap, and the mandate's boundary. */
function AuthorityHeader({ a }: { a: Authority }) {
  const usd = (v: string | bigint) => money(v, a.limits.decimals);
  return (
    <div className="mt-4">
      <h1 data-testid="authority" className="text-[15px] font-normal text-muted">
        {a.principal} delegated authority to {a.delegate} under Mandate {a.mandate}
      </h1>
      <dl data-testid="money" className="mt-3 flex flex-wrap gap-x-10 gap-y-2">
        <div>
          <dt className="text-sm text-muted">Treasury</dt>
          <dd data-testid="treasury" className="text-2xl font-extrabold tabular-nums text-heading">
            {usd(a.balance)}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Daily spend</dt>
          <dd data-testid="daily-spend" className="text-2xl font-extrabold tabular-nums text-heading">
            {usd(a.spent)} <span className="text-base font-semibold text-muted">/ {usd(a.limits.daily_cap)}</span>
          </dd>
        </div>
      </dl>
      <p data-testid="scale-note" className="mt-2 text-[13px] text-muted">
        Cardano preprod · Amounts shown at 1/1000 demo scale
      </p>
      <div className="mt-4">
        <BoundaryRail limits={a.limits} amount={null} placed={false} revoked={a.revoked} full />
      </div>
      {a.goal ? (
        <p data-testid="goal" className="mt-4 text-lg font-semibold">
          Goal: {a.goal}
        </p>
      ) : null}
    </div>
  );
}

/** Stage run | Attacks. Dates live in the banner and the tile tooltips, not in the control. */
function RunPicker({ runs, value, onChange }: { runs: RunSummary[]; value: string | null; onChange: (id: string) => void }) {
  const stage = runs.find((r) => r.kind === 'stage') ?? null;
  const firstLab = ATTACKS.flatMap((a) => runs.filter((r) => r.kind === 'lab' && r.attack === a.id))[0] ?? null;
  const onLab = runs.find((r) => r.run_id === value)?.kind === 'lab';
  return (
    <div role="radiogroup" aria-label="Recorded run" className="seg">
      <button type="button" role="radio" aria-checked={!onLab} disabled={stage === null} onClick={() => stage && onChange(stage.run_id)}>
        Stage run
      </button>
      <button type="button" role="radio" aria-checked={onLab} disabled={firstLab === null} onClick={() => firstLab && onChange(firstLab.run_id)}>
        Attacks
      </button>
    </div>
  );
}
