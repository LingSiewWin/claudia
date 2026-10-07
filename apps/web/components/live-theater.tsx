'use client';
import { useEffect, useState } from 'react';
import { getMandate, getMetrics, listRuns, startRun } from '../lib/api';
import { config } from '../lib/config';
import type { Limits, MandateView, Metrics, RunSummary } from '../lib/contract';
import { clock, money } from '../lib/format';
import { useEventStream, useLoad, useNow, useReplay } from '../lib/hooks';
import { type RunView, metricsOf, treasury, units } from '../lib/run';
import { ActionCard } from './action-card';
import { AttackLab } from './attack-lab';
import { BoundaryRail } from './boundary-rail';
import { type Mode, ModeBanner } from './mode-banner';

export function LiveTheater({ initialMode, initialRun }: { initialMode: Mode; initialRun: string | null }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [liveRun, setLiveRun] = useState<string | null>(initialMode === 'live' ? initialRun : null);
  const [replayRun, setReplayRun] = useState<string | null>(initialMode === 'replay' ? initialRun : null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const view: RunView = mode === 'live' ? live.view : replay.view;
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

  return (
    <div data-mode={mode} className="min-h-dvh bg-surface text-fg">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-8 lg:grid-cols-[minmax(0,46rem)_1fr]">
        <section aria-label="Agent actions" className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="Mode" className="inline-flex rounded-full border border-line p-1 text-sm font-bold">
              {(['live', 'replay'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded-full px-3 py-1 ${mode === m ? 'bg-fg text-surface' : 'text-muted'}`}
                >
                  {m === 'live' ? 'LIVE EXECUTION' : 'REPLAY'}
                </button>
              ))}
            </div>
            {mode === 'live' ? (
              <button type="button" className="btn-strong" onClick={run} disabled={starting}>
                {starting ? 'Starting…' : liveRun ? 'Run the agent again' : 'Run the agent'}
              </button>
            ) : (
              <RunPicker runs={runs.data?.runs ?? []} value={replayRun} onChange={setReplayRun} />
            )}
          </div>

          <div className="mt-5">
            <ModeBanner
              mode={mode}
              recordedAt={mode === 'replay' ? replay.recordedAt : null}
              verdict={mode === 'replay' ? replay.verdict : null}
              banner={mode === 'replay' ? replay.banner : null}
            />
          </div>

          {authority ? <AuthorityHeader a={authority} /> : null}
          <MetricsStrip
            metrics={mode === 'live' ? apiMetrics.data : metricsOf(view)}
            source={mode === 'live' ? (apiMetrics.data ? 'api' : 'none') : 'replay'}
          />

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

          <ol className="mt-6 space-y-5">
            {view.cards.map((card) => (
              <li key={card.actionId}>
                <ActionCard
                  card={card}
                  started={view.started}
                  now={now}
                  unanchored={mode === 'replay' && replay.unanchored.has(card.actionId)}
                />
              </li>
            ))}
          </ol>
          {mode === 'replay' && !replay.done && view.cards.length > 0 ? (
            <button type="button" className="btn-quiet mt-4" onClick={replay.skip}>
              Skip to the end
            </button>
          ) : null}
        </section>

        <aside aria-label="Attack Lab" className="min-w-0">
          {mode === 'live' ? (
            <AttackLab />
          ) : (
            <p className="text-sm text-muted">The Attack Lab runs real attempts, so it is available in LIVE EXECUTION only.</p>
          )}
        </aside>
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
    <div className="mt-6">
      <h1 data-testid="authority" className="text-[15px] font-normal text-muted">
        {a.principal} delegated authority to {a.delegate} under Mandate {a.mandate}
      </h1>
      <dl data-testid="money" className="mt-3 flex flex-wrap gap-x-10 gap-y-2">
        <div>
          <dt className="text-sm text-muted">Treasury</dt>
          <dd data-testid="treasury" className="text-2xl font-extrabold tabular-nums">
            {usd(a.balance)}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Daily spend</dt>
          <dd data-testid="daily-spend" className="text-2xl font-extrabold tabular-nums">
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

/** The headline is interruptions per 100 actions: the number the bond and the budget exist to push down. */
function MetricsStrip({ metrics: m, source }: { metrics: Metrics | null; source: 'api' | 'replay' | 'none' }) {
  if (!m) return null;
  const b = m.bonds;
  return (
    <dl data-testid="metrics" data-source={source} className="mt-5 flex flex-wrap gap-x-8 gap-y-2 border-y border-line py-3">
      <div>
        <dt className="text-sm text-muted">Interruptions / 100 actions</dt>
        <dd data-testid="metric-interruptions" className="text-2xl font-extrabold tabular-nums">
          {m.interruptions_per_100_actions}
        </dd>
      </div>
      <div>
        <dt className="text-sm text-muted">Actions evaluated</dt>
        <dd data-testid="metric-evaluated" className="text-2xl font-extrabold tabular-nums">
          {m.actions_evaluated}{' '}
          <span className="text-sm font-semibold text-muted">
            <span className="text-permit">{m.allow}</span> allow · <span className="text-cosign">{m.escalate}</span> escalate ·{' '}
            <span className="text-forbid">{m.deny}</span> deny
          </span>
        </dd>
      </div>
      <div>
        <dt className="text-sm text-muted">Bonds</dt>
        <dd data-testid="metric-bonds" className="text-2xl font-extrabold tabular-nums">
          {b.locked}{' '}
          <span className="text-sm font-semibold text-muted">
            locked · {b.required} required · {b.refunded} refunded · {b.captured} captured
          </span>
        </dd>
      </div>
      <div>
        <dt className="text-sm text-muted">Denied, nobody paged</dt>
        <dd data-testid="metric-budget" className="text-2xl font-extrabold tabular-nums">
          {m.budget_exhausted}
        </dd>
      </div>
      {m.median_decision_ms !== null ? (
        <div>
          <dt className="text-sm text-muted">Median human decision</dt>
          <dd className="text-2xl font-extrabold tabular-nums">{Math.round(m.median_decision_ms / 1000)}s</dd>
        </div>
      ) : null}
      <p className="basis-full text-[12px] text-muted">
        {source === 'api' ? `Across every run of Mandate ${config.stageMandateId}, from the evidence log.` : 'This recorded run, counted from its events in your browser.'}
      </p>
    </dl>
  );
}

function RunPicker({ runs, value, onChange }: { runs: RunSummary[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">Recorded run</span>
      <select
        className="rounded-md border border-line bg-raised px-2 py-1 text-fg"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        {runs.map((r) => (
          <option key={r.run_id} value={r.run_id}>
            {r.kind === 'lab' ? `Attack Lab: ${r.attack ?? 'attack'}` : `${r.mandate_id} stage run`} ({r.started_at.slice(0, 10)}{' '}
            {clock(r.started_at)})
          </option>
        ))}
      </select>
    </label>
  );
}
