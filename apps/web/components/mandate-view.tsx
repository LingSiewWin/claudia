'use client';
import Link from 'next/link';
import { getAuthority, getMandate } from '../lib/api';
import { cardanoTxUrl } from '../lib/config';
import { budgetText, money, shortHex } from '../lib/format';
import { useLoad } from '../lib/hooks';
import { readMandate, treasuryNote } from '../lib/mandate';
import { BoundaryRail } from './boundary-rail';

export function MandateView({ id }: { id: string }) {
  const { data, error } = useLoad(() => getMandate(id).then(readMandate), [id]);
  const role = data?.mandate.approvers[0]?.role ?? null;
  const authority = useLoad(role ? () => getAuthority(role, id) : null, [id, role]);
  if (error) return <p role="alert" className="text-forbid">{error}</p>;
  if (!data) return <p className="text-muted">Loading mandate {id}…</p>;
  const { limits, vault, anchor, mandate, balance, floor, spent, dayCap } = data;
  const perDay = mandate.interrupt_budget.per_day;
  const used = authority.data?.interrupt_budget.used ?? null;
  const d = limits.decimals;
  const usd = (v: string | bigint) => money(v, d);
  const revoked = anchor.status === 'revoked';
  const spentPct = Number((spent * 100n) / (dayCap === 0n ? 1n : dayCap));
  const floorPct = balance === 0n ? 100 : Math.min(100, Number((floor * 100n) / balance));
  const purposes = mandate.constraints.flatMap((c) => (c.kind === 'purpose_in' ? c.values : []));
  const vendors = mandate.constraints.flatMap((c) => (c.kind === 'counterparty_in' ? c.values : []));

  return (
    <article data-testid="mandate" className="grid gap-10 lg:grid-cols-2 lg:gap-x-16">
      <header className="lg:col-span-2">
        <p className="text-sm text-muted">Mandate {mandate.id}</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">
          {mandate.principal.name} delegated to {mandate.delegate.id}
        </h1>
        <p className="mt-2 text-muted">
          Purpose: {purposes.join(', ')}. Approved vendors: {vendors.join(', ')}. Valid {mandate.validity.starts_at.slice(0, 10)} to{' '}
          {mandate.validity.expires_at.slice(0, 10)}.
        </p>
        <p data-testid="scale-note" className="mt-2 text-[13px] text-muted">
          Cardano preprod · Amounts shown at 1/1000 demo scale
        </p>
      </header>

      <section aria-label="Authority boundary" className="lg:col-span-2">
        <h2 className="mb-3 text-lg font-bold">Who can move how much, per payment</h2>
        <BoundaryRail limits={limits} amount={null} placed={false} revoked={revoked} full />
      </section>

      <section aria-label="Today" className="grid gap-8 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-3">
        <Meter
          title="Daily spend"
          value={`${usd(spent)} / ${usd(dayCap)}`}
          note="Resets every day"
          fill={spentPct}
          testId="daily-meter"
        />
        <Meter
          title="Treasury"
          value={usd(balance)}
          note={treasuryNote(revoked, floor, balance, d)}
          fill={100}
          marker={floorPct}
          testId="treasury-meter"
        />
        <Meter
          title="Interrupt budget"
          value={used === null ? `${perDay} a day` : budgetText(used, perDay)}
          note={
            used === null
              ? authority.error
                ? "Today's use is unavailable right now"
                : 'Escalations the agent may raise to a human per day'
              : used >= perDay
                ? 'Spent. Further escalations are denied and nobody is paged.'
                : `${perDay - used} left. Beyond that, escalations are denied and nobody is paged.`
          }
          fill={used === null ? 0 : perDay === 0 ? 100 : (used * 100) / perDay}
          testId="budget-meter"
        />
        {role ? (
          <div className="self-end text-sm">
            <Link className="underline" href={`/authority/${encodeURIComponent(role)}?mandate_id=${encodeURIComponent(mandate.id)}`}>
              What it costs an agent to reach the {role}
            </Link>
          </div>
        ) : null}
      </section>

      <section aria-label="On-chain anchor" className="min-w-0 text-sm lg:col-span-2">
        <h2 className="mb-2 text-lg font-bold">Enforced on Cardano</h2>
        <p data-testid="anchor-status" className="text-fg">
          <span aria-hidden className={`mr-1.5 inline-block size-2 rounded-full ${revoked ? 'bg-forbid' : 'bg-permit'}`} />
          Anchor version {anchor.version}, {revoked ? <strong>revoked</strong> : <strong>active</strong>}
          {', '}
          <a className="underline" href={cardanoTxUrl(anchor.tx_hash)} target="_blank" rel="noreferrer">
            anchor tx <span className="font-mono text-[13px]">{shortHex(anchor.tx_hash)}</span>
          </a>
        </p>
        <p className="mt-1">
          Vault <span className="font-mono text-[13px]">{shortHex(vault.vault_hash)}</span>, last nonce {vault.last_nonce},{' '}
          <a className="underline" href={cardanoTxUrl(vault.tx_hash)} target="_blank" rel="noreferrer">
            vault state tx <span className="font-mono text-[13px]">{shortHex(vault.tx_hash)}</span>
          </a>
        </p>
        <p className="mt-1 font-mono text-[13px] break-all text-muted">mandate hash {data.mandate_hash}</p>
      </section>
    </article>
  );
}

function Meter({
  title,
  value,
  note,
  fill,
  marker,
  testId,
}: {
  title: string;
  value: string;
  note: string;
  fill: number;
  marker?: number;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <p className="text-sm text-muted">{title}</p>
      <p className="text-2xl font-extrabold">{value}</p>
      <p className="text-sm text-muted">{note}</p>
      <div className="relative mt-2 h-3 overflow-hidden rounded-sm bg-line">
        <div className="h-full bg-fg/60" style={{ width: `${Math.min(100, fill)}%` }} />
        {marker === undefined ? null : (
          <span className="absolute top-0 h-full w-[3px] bg-forbid" style={{ left: `${marker}%` }} title="Treasury minimum" />
        )}
      </div>
    </div>
  );
}
