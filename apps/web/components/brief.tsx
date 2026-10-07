import type { DecisionBrief } from '@authority/core';
import type { ReactNode } from 'react';
import { cardanoscanTxUrl, sepoliaTxUrl } from '../lib/config';
import type { BondRef } from '../lib/contract';
import { BOND_TEXT, bondAmount, bondStatus, budgetText, clock, money, plainReason, shortHex } from '../lib/format';

const CHECK_GLYPH: Record<string, [string, string]> = {
  pass: ['✓', 'text-permit'],
  fail: ['✕', 'text-forbid'],
  approval: ['!', 'text-cosign'],
};
const CHIP_TONE: Record<BondRef['status'], string> = {
  required: 'text-cosign',
  locked: 'text-fg',
  refunded: 'text-permit',
  captured: 'text-forbid',
  expired: 'text-muted',
};
const FACT_NAME: Record<string, string> = {
  exists: 'invoice exists',
  customer_match: 'addressed to us',
  status_open: 'still open',
  amount_match: 'amount matches',
  currency_match: 'currency matches',
  recipient_match: 'pays the vendor on record',
};

/**
 * The bond an agent locked to reach a human: status, amount, and the escrow or outcome transaction.
 * A priced bond nobody locked before its window closed reads as expired.
 */
export function BondChip({ bond, now }: { bond: BondRef; now: number }) {
  const status = bondStatus(bond, now);
  const tx = bond.outcome_tx_hash ?? bond.tx_hash;
  return (
    <span
      data-testid="bond-chip"
      data-status={status}
      className="inline-flex items-baseline gap-1.5 rounded-sm border border-line px-1.5 py-px text-[12px] font-semibold tracking-wide"
    >
      <span className={CHIP_TONE[status]}>{BOND_TEXT[status]}</span>
      <span className="font-normal tabular-nums text-muted">{bondAmount(bond)}</span>
      {tx ? (
        <a className="font-mono font-normal underline" href={cardanoscanTxUrl(tx)} target="_blank" rel="noreferrer">
          {shortHex(tx, 6, 4)}
        </a>
      ) : null}
    </span>
  );
}

/**
 * The Decision Brief in the order a human reads it: what, why (the agent's claim), what the engine checked, what was
 * verified, why a human, what exactly will happen, cost, expiry. Every value comes from the brief the engine built;
 * nothing here is composed in the browser.
 */
export function BriefView({ brief, bond, now, decimals = 6 }: { brief: DecisionBrief; bond: BondRef | null; now: number; decimals?: number }) {
  const w = brief.what;
  const v = brief.verified;
  const b = brief.cost.bond;
  const expiresIn = Math.round((brief.expires_at_ms - now) / 60_000);
  return (
    <dl data-testid="brief" className="divide-y divide-line border-y border-line text-[15px]">
      <Section name="What">
        <p>
          <span className="text-xl font-extrabold tabular-nums text-fg">{money(w.amount.value, decimals)}</span>{' '}
          <span className="font-mono text-[13px] text-muted">{w.amount.display}</span> to <strong>{w.counterparty.display}</strong>
          {w.reference ? (
            <>
              {' '}
              for <span className="font-mono text-[13px]">{w.reference.invoice_number}</span>
            </>
          ) : null}
        </p>
        <p className="font-mono text-[13px] break-all text-muted">recipient {w.recipient}</p>
      </Section>
      <Section name="Why" note="the agent's claim, shown, not trusted">
        <q>{brief.why}</q>
      </Section>
      <Section name="What the engine checked" note={`Mandate ${brief.mandate.id} v${brief.mandate.version}`}>
        <ul className="space-y-0.5 text-sm">
          {brief.engine.checks.map((k) => {
            const [glyph, tone] = CHECK_GLYPH[k.result] ?? ['·', 'text-muted'];
            return (
              <li key={k.id} className="flex gap-2">
                <span aria-hidden className={tone}>
                  {glyph}
                </span>
                <span>
                  <span className="font-mono text-[13px]">{k.id}</span>
                  {k.reason ? <span className="text-muted">: {plainReason(k.reason)}</span> : null}
                  {k.result === 'not_evaluated' ? <span className="text-muted"> (not evaluated)</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section name="What was verified" note="Chainlink CRE">
        {v ? (
          <>
            <p>
              <strong className={v.result === 'VERIFIED' ? 'text-permit' : 'text-forbid'}>{v.result}</strong>
              {v.sepolia_tx ? (
                <>
                  {' · '}
                  <a className="underline" href={sepoliaTxUrl(v.sepolia_tx)} target="_blank" rel="noreferrer">
                    Sepolia tx <span className="font-mono text-[13px]">{shortHex(v.sepolia_tx)}</span>
                  </a>
                </>
              ) : null}
            </p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
              {Object.entries(v.facts).map(([k, ok]) => (
                <li key={k} className={ok ? 'text-fg' : 'text-forbid'}>
                  <span aria-hidden>{ok ? '✓' : '✕'}</span> {FACT_NAME[k] ?? k}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-muted">No external facts were needed for this action.</p>
        )}
      </Section>
      <Section name="Why a human">
        {brief.escalation ? (
          <ul className="space-y-0.5">
            {brief.escalation.because.map((r) => (
              <li key={r.constraint}>
                {plainReason(r.reason)} <span className="font-mono text-[13px] text-muted">{r.constraint}</span>
              </li>
            ))}
            <li className="text-sm text-muted">Approver: {brief.escalation.approver}</li>
          </ul>
        ) : (
          <p className="text-muted">The engine did not ask for a human.</p>
        )}
      </Section>
      <Section name="What exactly will happen">
        <p data-testid="will-happen" className="font-mono text-[13px] leading-relaxed break-all">
          {brief.will_happen}
        </p>
      </Section>
      <Section name="Cost">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {bond ? <BondChip bond={bond} now={now} /> : b ? <span className="text-sm">Bond {bondAmount(b)}</span> : <span className="text-sm text-muted">No bond</span>}
          <span data-testid="budget" className="text-sm">
            Interrupt budget {budgetText(brief.cost.interrupt_budget.used, brief.cost.interrupt_budget.per_day)}
          </span>
        </div>
      </Section>
      <Section name="Expires">
        <p className="tabular-nums">
          <time dateTime={new Date(brief.expires_at_ms).toISOString()}>{clock(new Date(brief.expires_at_ms).toISOString())}</time>
          <span className="ml-2 text-sm text-muted">{expiresIn > 0 ? `in ${expiresIn} min` : 'expired'}</span>
        </p>
      </Section>
    </dl>
  );
}

function Section({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt>
        <p className="text-[12px] font-extrabold uppercase tracking-wider text-fg">{name}</p>
        {note ? <p className="text-[12px] text-muted">{note}</p> : null}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
