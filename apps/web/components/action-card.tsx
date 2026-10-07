'use client';
import { verifyAuthorizationRecord } from '@authority/core';
import Link from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';
import { cardanoTxUrl, sepoliaTxUrl } from '../lib/config';
import type { Payloads } from '../lib/contract';
import { DECLINE_REASON_TEXT, actionTitle, clock, money, plainReason, shortHex } from '../lib/format';
import { type CardView, type Row, type RowTone, budgetExhausted, enforcedRow, mayRow, statusLine, trueRow } from '../lib/run';
import { BoundaryRail } from './boundary-rail';
import { BondChip, BriefView } from './brief';

type Started = Payloads['RunStarted'];

// Status colours mark outcomes only: a coloured value or glyph, never a coloured sentence or border.
const TONE: Record<RowTone, string> = {
  pending: 'text-muted',
  pass: 'text-permit',
  approval: 'text-cosign',
  fail: 'text-forbid',
  skipped: 'text-muted',
};
const DOT: Record<RowTone, string> = {
  pending: 'bg-muted',
  pass: 'bg-permit',
  approval: 'bg-cosign',
  fail: 'bg-forbid',
  skipped: 'bg-muted',
};

/**
 * The face of one agent action: what, how much, where it falls on the boundary, what happened, and two buttons.
 * WHY? selects the card (`onSelect`); the owner shows its `ActionDetail` where it fits (the side panel on /live, or
 * inline through `children`). `unanchored`: in REPLAY, this action has evidence after the log head committed on Cardano.
 */
export function ActionCard({
  card,
  started,
  now,
  index = null,
  unanchored = false,
  selected = false,
  onSelect,
  children,
}: {
  card: CardView;
  started: Started | null;
  now: number;
  /** Position in the run, shown as a small counter. */
  index?: { n: number; of: number } | null;
  unanchored?: boolean;
  selected?: boolean;
  onSelect?: (actionId: string) => void;
  children?: ReactNode;
}) {
  const a = card.action;
  const amount = a?.amount.value ?? card.authorization?.fields.amount ?? null;
  const decimals = started?.limits.decimals ?? 6;
  const status = statusLine(card);
  const denied = card.state === 'DENIED';

  return (
    <article
      data-testid="action-card"
      data-state={card.state}
      data-action-id={card.actionId}
      data-active={selected || undefined}
      data-unanchored={unanchored || undefined}
      className="stage-card"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="stage-index">
            {index ? `${String(index.n).padStart(2, '0')} / ${String(index.of).padStart(2, '0')} · ` : null}
            {a?.reference ? `${a.reference.invoice_number} · ` : null}
            <time dateTime={card.proposedAt}>{clock(card.proposedAt)}</time>
          </p>
          <h3 className="mt-1 text-[22px] font-semibold leading-tight text-heading">{a ? actionTitle(a) : 'Payment outside the mandate'}</h3>
        </div>
        <p className="stage-amount shrink-0">{amount === null ? '—' : money(amount, decimals)}</p>
      </div>
      {card.bond || unanchored ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
          {card.bond ? <BondChip bond={card.bond} now={now} /> : null}
          {unanchored ? (
            <span data-testid="not-anchored" className="rounded-sm border border-line px-1.5 py-px text-[11px] font-bold uppercase tracking-wider text-fg">
              not anchored
            </span>
          ) : null}
        </p>
      ) : null}
      {started ? (
        <div className="mt-5">
          <BoundaryRail limits={started.limits} amount={amount} placed={card.evaluation !== null || card.compromisedEngine} />
        </div>
      ) : null}

      <p data-testid="status" data-tone={status.tone} className="mt-5 flex items-center gap-2 font-semibold text-fg">
        <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${DOT[status.tone]}`} />
        {status.text}
      </p>

      <div className="stage-actions">
        <button type="button" onClick={() => onSelect?.(card.actionId)} aria-expanded={selected} className="btn">
          WHY?
        </button>
        {card.receipt ? (
          <Link href={`/receipt/${encodeURIComponent(card.receipt.id)}`} className="btn-strong">
            PROVE
          </Link>
        ) : (
          <button type="button" className="btn-strong" disabled title={denied ? 'Nothing to prove: no money moved' : 'PROVE after settlement'}>
            PROVE
          </button>
        )}
      </div>
      {children}
    </article>
  );
}

/**
 * Everything behind WHY?: the outcome in plain words, the Decision Brief, the agent's claim, MAY? / TRUE? / ENFORCED,
 * the settlement steps, the authority chain, and the Protocol view.
 */
export function ActionDetail({ card, started, now }: { card: CardView; started: Started | null; now: number }) {
  const [protocol, setProtocol] = useState(false);
  const a = card.action;
  const auth = card.authorization;
  const decimals = started?.limits.decimals ?? 6;
  const denied = card.state === 'DENIED';
  const authValid = useMemo(
    () => (auth && started ? verifyAuthorizationRecord(auth, started.engine_public_key) : null),
    [auth, started],
  );

  return (
    <section data-testid="technical" data-action-id={card.actionId} aria-label="How this was decided">
      {denied && card.denied ? (
        <div data-testid="denied" className="border-l-[3px] border-fg pl-3">
          <p className="text-fg">{plainReason(card.denied.reason)}</p>
          {card.approval?.declineReason ? <p className="text-sm text-muted">{DECLINE_REASON_TEXT[card.approval.declineReason]}</p> : null}
          {budgetExhausted(card) ? (
            <p data-testid="nobody-paged" className="text-sm font-semibold text-fg">
              Nobody was paged.
            </p>
          ) : null}
          <p className="text-sm text-muted">Funds moved: {money(0n, decimals, true)}</p>
        </div>
      ) : null}
      {a ? (
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          <span className="font-semibold text-fg">Why the agent wants this: </span>
          <q className="font-serif text-[17px] italic">{a.rationale}</q>
        </p>
      ) : null}
      {card.approval?.brief ? (
        <details data-testid="brief-details" open={card.state === 'ESCALATED'} className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold">Decision brief</summary>
          <div className="mt-2">
            <BriefView brief={card.approval.brief} bond={card.bond} now={now} decimals={decimals} />
          </div>
        </details>
      ) : null}
      {card.state === 'EXECUTING' ? <Progress card={card} authValid={authValid} now={now} /> : null}

      <dl className="mt-4 divide-y divide-line border-y border-line">
        <RowLine name="MAY?" system="Authority Engine" row={mayRow(card)} testId="row-may" />
        <RowLine name="TRUE?" system="Chainlink CRE" row={trueRow(card)} testId="row-true" />
        <RowLine name="ENFORCED" system="Cardano Vault" row={enforcedRow(card)} testId="row-enforced" />
      </dl>
      {card.state === 'SETTLED' || card.state === 'PROVEN' ? <Progress card={card} authValid={authValid} now={now} /> : null}
      <button type="button" onClick={() => setProtocol((p) => !p)} aria-pressed={protocol} className="btn-quiet mt-4">
        {protocol ? 'Human view' : 'Protocol view'}
      </button>
      {protocol ? <ProtocolView card={card} started={started} /> : <AuthorityChain card={card} started={started} />}
    </section>
  );
}

function RowLine({ name, system, row, testId }: { name: string; system: string; row: Row; testId: string }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr_auto] items-baseline gap-3 py-2" data-testid={testId} data-tone={row.tone}>
      <dt className="font-extrabold tracking-tight text-fg">{name}</dt>
      <dd className="text-sm text-muted">{system}</dd>
      <dd className={`text-right font-semibold ${TONE[row.tone]}`}>
        {row.value}
        {row.reason ? <span className="block font-mono text-[12px] font-normal text-muted">{row.reason}</span> : null}
      </dd>
    </div>
  );
}

function Progress({ card, authValid, now }: { card: CardView; authValid: boolean | null; now: number }) {
  const { tx } = card;
  const end = tx.confirmedAt ? Date.parse(tx.confirmedAt) : now;
  const elapsed = tx.submittedAt ? Math.max(0, Math.round((end - Date.parse(tx.submittedAt)) / 1000)) : null;
  return (
    <ol data-testid="progress" className="mt-4 space-y-1 text-sm">
      <Step source="browser" done={authValid === true} failed={authValid === false}>
        Authorization signature
      </Step>
      <Step source="server" done={tx.submittedAt !== null}>
        Vault script accepted the transaction
      </Step>
      <Step source="server" done={tx.hash !== null && tx.submittedAt !== null}>
        Submitted{' '}
        {tx.hash ? (
          <a className="font-mono text-[13px] underline" href={cardanoTxUrl(tx.hash)} target="_blank" rel="noreferrer">
            {shortHex(tx.hash)}
          </a>
        ) : null}
      </Step>
      <Step source="server" done={tx.confirmedAt !== null}>
        {tx.confirmedAt ? `Settled in block ${tx.block ?? '?'}` : 'Waiting for a block'}
        {elapsed === null ? null : <span className="ml-2 tabular-nums text-muted">{elapsed}s</span>}
      </Step>
      {card.receipt ? (
        <Step source="server" done>
          Receipt {card.receipt.id} issued
        </Step>
      ) : null}
    </ol>
  );
}

/**
 * A check this browser ran itself gets the check mark; a step the server reported gets a plain dot. Each says which.
 */
function Step({ source, done, failed = false, children }: { source: 'browser' | 'server'; done: boolean; failed?: boolean; children: ReactNode }) {
  const browser = source === 'browser';
  const glyph = failed ? '✕' : !done ? '○' : browser ? '✓' : '●';
  return (
    <li data-source={source} className={`flex flex-wrap items-baseline gap-x-2 ${done ? 'text-fg' : 'text-muted'}`}>
      <span aria-hidden className={failed ? 'text-forbid' : done && browser ? 'text-permit' : 'text-muted'}>
        {glyph}
      </span>
      <span>{children}</span>
      <span className="text-[12px] text-muted">{browser ? 'checked in your browser' : 'reported by server'}</span>
    </li>
  );
}

function AuthorityChain({ card, started }: { card: CardView; started: Started | null }) {
  const checks = card.evaluation?.checks ?? [];
  const may = mayRow(card);
  const truth = trueRow(card);
  return (
    <ol data-testid="authority-chain" className="mt-3 space-y-2 border-l-[3px] border-fg pl-4 text-[15px]">
      <li>
        <strong>{started?.principal ?? 'Principal'}</strong> delegated to <strong>{started?.delegate ?? 'the agent'}</strong>
      </li>
      <li>
        under Mandate <strong>{started ? `${started.mandate_id} v${started.mandate_version}` : '?'}</strong>
      </li>
      <li>
        constraints checked
        <ul className="mt-1 space-y-0.5 text-sm">
          {checks.map((k) => (
            <li key={k.id} className="flex gap-2">
              <span className={k.result === 'pass' ? 'text-permit' : k.result === 'fail' ? 'text-forbid' : k.result === 'approval' ? 'text-cosign' : 'text-muted'}>
                {k.result === 'pass' ? '✓' : k.result === 'fail' ? '✕' : k.result === 'approval' ? '!' : '·'}
              </span>
              <span>
                <span className="font-mono text-[13px]">{k.id}</span>
                {k.reason ? <span className="text-muted">: {plainReason(k.reason)}</span> : null}
                {k.result === 'not_evaluated' ? <span className="text-muted"> (not evaluated)</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </li>
      <li>
        invoice check: <strong>{truth.value}</strong>
        {truth.reason ? ` (${plainReason(truth.reason)})` : null}
      </li>
      <li>
        decision: <strong>{may.value === 'ALLOW' && truth.tone === 'fail' ? 'DENY' : may.value}</strong>
        {card.approval ? `, CFO ${card.approval.status}` : null}
      </li>
    </ol>
  );
}

function ProtocolView({ card, started }: { card: CardView; started: Started | null }) {
  const a = card.authorization;
  const ev = card.evaluation;
  const rows: Array<[string, string | null]> = [
    ['mandate', started ? `${started.mandate_id} v${started.mandate_version}` : null],
    ['action id', card.actionId],
    ['action hash', card.actionHash],
    ['agent key', started?.agent_public_key ?? null],
    ['agent signature', card.agentSignature],
    ['invoice hash', card.verification?.report.invoice_hash ?? null],
    ['CRE report hash', card.verification?.reportHash ?? null],
    ['Sepolia tx', card.verification?.sepoliaTx ?? null],
    ['decision', ev ? `${ev.outcome}${ev.reason ? ` ${ev.reason}` : ''}` : null],
    ['nonce', a?.fields.nonce ?? null],
    ['expiry', a ? new Date(a.fields.valid_until).toISOString() : null],
    ['digest', a?.digest_hex ?? null],
    ['engine signature', a?.signature_hex ?? null],
    ['engine key', a?.engine_public_key ?? null],
    ['Cardano tx', card.tx.hash],
    ['attempted tx body', card.denied?.layer === 'vault' ? card.tx.bodyCbor : null],
  ];
  return (
    <dl data-testid="protocol-view" className="mt-3 grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-sm">
      {rows
        .filter((r): r is [string, string] => r[1] !== null)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="flex min-w-0 items-start gap-2">
              <code className="min-w-0 break-all font-mono text-[13px] text-fg">
                {k === 'Sepolia tx' ? (
                  <a className="underline" href={sepoliaTxUrl(v)} target="_blank" rel="noreferrer">
                    {v}
                  </a>
                ) : k === 'Cardano tx' ? (
                  <a className="underline" href={cardanoTxUrl(v)} target="_blank" rel="noreferrer">
                    {v}
                  </a>
                ) : (
                  v
                )}
              </code>
              <button type="button" className="text-muted underline" onClick={() => navigator.clipboard.writeText(v)}>
                copy
              </button>
            </dd>
          </div>
        ))}
    </dl>
  );
}
