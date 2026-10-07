'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { Metrics } from '../../lib/contract';
import { DECLINE_REASON_TEXT, actionTitle, clock, money, plainReason } from '../../lib/format';
import { type CardView, type RunView, enforcedRow, mayRow, statusLine, trueRow } from '../../lib/run';
import { BondChip } from '../brief';
import { type StepView, type Step } from './model';
import { Scene } from './scene';
import { useFloor } from './use-floor';

const STEP_LABEL: Record<Step, string> = {
  proposed: 'Proposed',
  evaluated: 'Evaluated',
  verified: 'Verified',
  bond: 'Bond',
  human: 'Human',
  settled: 'Settled',
  proven: 'Proven',
};
const STEP_DOT: Record<StepView['status'], string> = {
  pending: 'border border-line bg-transparent',
  current: 'bg-cosign ring-4 ring-cosign/25',
  done: 'bg-permit',
  failed: 'bg-forbid',
  skipped: 'bg-line',
};
const TONE: Record<string, string> = { pending: 'text-muted', pass: 'text-permit', approval: 'text-cosign', fail: 'text-forbid', skipped: 'text-muted' };

/**
 * The floor with its overlays: stat tiles (top-left), the selected action's brief (right), the step tracker (bottom).
 * `metrics` is the API's number in LIVE and `metricsOf(view)` in REPLAY; the caller decides, the stage only shows.
 */
export function FloorStage({
  view,
  metrics,
  source,
  now,
  detail = true,
  mode = 'replay',
  children,
}: {
  view: RunView;
  metrics: Metrics | null;
  source: 'api' | 'replay' | 'none';
  now: number;
  /** Show the right-hand brief panel. */
  detail?: boolean;
  mode?: 'live' | 'replay';
  /** Anything to float over the top-right corner when there is no detail panel (the hero's replay tag). */
  children?: React.ReactNode;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const floor = useFloor(view, picked);
  const card = floor.selected;
  const decimals = view.started?.limits.decimals ?? 6;
  return (
    <div data-testid="floor" className="floor" data-selected={card?.actionId ?? undefined}>
      <div className="grid gap-3 p-3 lg:block lg:p-0">
        <div className="order-2 lg:order-none">
          <Scene floor={floor} selected={card?.actionId ?? null} onSelect={setPicked} />
        </div>

        <dl data-testid="metrics" data-source={source} className="order-1 grid grid-cols-2 gap-2 lg:absolute lg:top-4 lg:left-4 lg:w-[38rem] lg:grid-cols-4">
          <Tile label="Interruptions / 100 actions" id="metric-interruptions" value={metrics ? String(metrics.interruptions_per_100_actions) : '—'} />
          <Tile label="Actions evaluated" id="metric-evaluated" value={metrics ? String(metrics.actions_evaluated) : '—'}>
            {metrics ? (
              <>
                <span className="text-permit">{metrics.allow}</span> allow · <span className="text-cosign">{metrics.escalate}</span> escalate ·{' '}
                <span className="text-forbid">{metrics.deny}</span> deny
              </>
            ) : null}
          </Tile>
          <Tile label="Bonds" id="metric-bonds" value={metrics ? String(metrics.bonds.locked) : '—'}>
            {metrics ? `${metrics.bonds.locked} locked · ${metrics.bonds.required} required · ${metrics.bonds.refunded} refunded · ${metrics.bonds.captured} captured` : null}
          </Tile>
          <Tile label="Denied, nobody paged" id="metric-budget" value={metrics ? String(metrics.budget_exhausted) : '—'} />
          <p className="col-span-2 px-1 text-[11px] text-muted lg:col-span-4">
            {metrics?.median_decision_ms != null ? `Median human decision ${Math.round(metrics.median_decision_ms / 1000)}s. ` : ''}
            {source === 'api' ? 'Across every run of this mandate, from the evidence log.' : source === 'replay' ? 'This recorded run, counted from its events in your browser.' : 'Metrics unavailable.'}
          </p>
        </dl>

        {detail ? (
          <aside aria-label="Decision brief" className="floor-glass order-3 p-4 lg:absolute lg:top-4 lg:right-4 lg:w-[20rem]">
            {card ? <Detail card={card} now={now} decimals={decimals} mode={mode} /> : <p className="text-sm text-muted">Waiting for the first proposal.</p>}
          </aside>
        ) : children ? (
          <div className="order-3 lg:absolute lg:top-4 lg:right-4">{children}</div>
        ) : null}

        <ol data-testid="floor-steps" aria-label="Steps" className="floor-glass order-4 grid grid-cols-4 gap-y-3 px-3 py-3 sm:grid-cols-7 lg:absolute lg:bottom-4 lg:left-4 lg:w-[46rem]">
          {floor.steps.map((s) => (
            <li key={s.step} data-step={s.step} data-status={s.status} className="min-w-0 overflow-hidden px-1">
              <div className="flex items-center gap-2">
                <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${STEP_DOT[s.status]}`} />
                <span className={`text-[12px] font-extrabold uppercase tracking-wider ${s.status === 'pending' || s.status === 'skipped' ? 'text-muted' : ''}`}>{STEP_LABEL[s.step]}</span>
              </div>
              <p className="mt-0.5 truncate pl-[18px] font-mono text-[11px] tabular-nums text-muted">
                {s.at ? clock(s.at).replace(' UTC', '') : s.status === 'skipped' ? (s.note ?? 'skipped') : '·'}
                {s.at && s.note ? ` ${s.note}` : ''}
              </p>
            </li>
          ))}
          {floor.steps.length === 0 ? <li className="col-span-full text-[12px] text-muted">The step tracker follows the selected action.</li> : null}
        </ol>
      </div>
    </div>
  );
}

function Tile({ label, id, value, children }: { label: string; id: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="floor-glass px-3 py-2.5">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</dt>
      <dd data-testid={id} className="mt-0.5 text-2xl font-extrabold leading-none tabular-nums">
        {value}
        {children ? <span className="mt-1 block text-[11px] font-semibold leading-snug text-muted">{children}</span> : null}
      </dd>
    </div>
  );
}

/** The selected action, in the order a human reads it: what, status, the three questions, the brief's core. */
function Detail({ card, now, decimals, mode }: { card: CardView; now: number; decimals: number; mode: 'live' | 'replay' }) {
  const a = card.action;
  const status = statusLine(card);
  const brief = card.approval?.brief ?? null;
  const rows = [
    ['MAY?', mayRow(card)],
    ['TRUE?', trueRow(card)],
    ['ENFORCED', enforcedRow(card)],
  ] as const;
  return (
    <div data-testid="floor-detail" data-action={card.actionId} data-state={card.state}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-lg font-bold leading-tight">{a ? actionTitle(a) : card.actionId}</p>
        <p className="text-xl font-extrabold tabular-nums">{a ? money(a.amount.value, decimals) : '—'}</p>
      </div>
      <p className="mt-0.5 font-mono text-[12px] text-muted">
        {card.actionId}
        {a?.reference ? ` · ${a.reference.invoice_number}` : ''} · {clock(card.proposedAt)}
      </p>
      <p data-tone={status.tone} className={`mt-3 text-[15px] font-semibold ${TONE[status.tone]}`}>
        {status.text}
      </p>
      {card.denied ? <p className="mt-1 text-sm">{plainReason(card.denied.reason)}</p> : null}
      {card.approval?.declineReason ? <p className="mt-1 text-sm text-muted">{DECLINE_REASON_TEXT[card.approval.declineReason]}</p> : null}
      <dl className="mt-3 divide-y divide-line border-y border-line text-sm">
        {rows.map(([name, r]) => (
          <div key={name} className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="font-mono text-[11px] font-bold tracking-wider text-muted">{name}</dt>
            <dd className={`text-right font-semibold ${TONE[r.tone]}`}>
              {r.value}
              {r.reason ? <span className="block text-[12px] font-normal text-muted">{plainReason(r.reason)}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {brief ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-[11px] font-extrabold uppercase tracking-wider">Decision brief</p>
          <p>
            <span className="text-muted">Why: </span>
            <q>{brief.why}</q>
          </p>
          {brief.escalation ? (
            <p>
              <span className="text-muted">Why a human: </span>
              {brief.escalation.because.map((b) => plainReason(b.reason)).join(' ')}
            </p>
          ) : null}
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {card.bond ? <BondChip bond={card.bond} now={now} /> : null}
            <span className="text-muted">
              Budget {brief.cost.interrupt_budget.used} of {brief.cost.interrupt_budget.per_day}
            </span>
          </p>
          {card.approval?.status === 'pending' ? (
            <p className="text-cosign">
              {mode === 'live' ? (
                <Link href="/console" className="underline underline-offset-4">
                  Waiting for the CFO: approve or decline in the console
                </Link>
              ) : (
                'Waiting for the CFO'
              )}
            </p>
          ) : card.approval ? (
            <p className={card.approval.status === 'approved' ? 'text-permit' : 'text-forbid'}>
              {card.approval.status === 'approved' ? 'Approved' : 'Declined'} by the CFO{card.approval.decidedAt ? ` at ${clock(card.approval.decidedAt)}` : ''}
            </p>
          ) : null}
        </div>
      ) : a ? (
        <p className="mt-3 text-sm text-muted">
          <q>{a.rationale}</q>
        </p>
      ) : null}
      {card.receipt ? (
        <Link href={`/receipt/${encodeURIComponent(card.receipt.id)}`} className="btn-strong mt-3 text-sm">
          Receipt {card.receipt.id}
        </Link>
      ) : null}
    </div>
  );
}
