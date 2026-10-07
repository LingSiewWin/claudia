'use client';
import { type ReactNode, useState } from 'react';
import { getReceipt } from '../lib/api';
import { koiosTx, sepoliaReceipt } from '../lib/chain';
import { cardanoTxUrl, config, dataSource, sepoliaTxUrl } from '../lib/config';
import { BOND_TEXT, actionTitle, bondAmount, money, shortHex } from '../lib/format';
import { cardanoscanTxUrl } from '../lib/config';
import { useLoad } from '../lib/hooks';
import { type CheckStatus, SUMMARY, type VerifyCheck, groupStatus, verdict, verifyReceipt } from '../lib/verify';

const DOT: Record<CheckStatus | 'pending', string> = {
  pass: 'bg-permit',
  fail: 'bg-forbid',
  unavailable: 'bg-cosign',
  pending: 'bg-muted',
};
const RESULT: Record<CheckStatus, string> = {
  pass: 'text-permit',
  fail: 'text-forbid',
  unavailable: 'text-fg',
};

/**
 * A receipt in business terms first (what was paid, to whom, by whose authority), then the settlement block that the
 * browser checks itself. Nothing on this page says "verified" unless verify() recomputed it here.
 */
export function ReceiptView({ id }: { id: string }) {
  const { data: b, error } = useLoad(() => getReceipt(id), [id]);
  const [checks, setChecks] = useState<VerifyCheck[] | null>(null);
  const [running, setRunning] = useState(false);
  if (error) return <p role="alert" className="text-forbid">{error}</p>;
  if (!b) return <p className="text-muted">Loading receipt {id}…</p>;
  const r = b.receipt;
  const ir = r.action.ir;
  const tx = r.settlement.tx_hash;

  const verify = async () => {
    setRunning(true);
    try {
      setChecks(await verifyReceipt(b, { cardano: koiosTx, sepolia: sepoliaReceipt, registry: config.registryAddress }));
    } catch (err) {
      setChecks([
        {
          id: 'cardano_tx',
          label: 'Cardano preprod (Koios)',
          status: 'unavailable',
          detail: err instanceof Error ? err.message : String(err),
        },
      ]);
    } finally {
      setRunning(false);
    }
  };
  const v = checks ? verdict(checks) : null;
  const line = (key: (typeof SUMMARY)[number]['key']) => {
    const g = SUMMARY.find((x) => x.key === key)!;
    const status: CheckStatus | 'pending' = checks ? groupStatus(checks, g.ids) : 'pending';
    return (
      <li key={g.key} data-testid={`summary-${g.key}`} data-status={status} className="flex items-start gap-2">
        <span aria-hidden className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${DOT[status]}`} />
        <span className={status === 'pending' ? 'text-muted' : 'text-fg'}>{g.label}</span>
      </li>
    );
  };

  return (
    <article data-testid="receipt" className="space-y-10">
      <header>
        <p className="font-mono text-[13px] text-muted">Receipt {id}</p>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-6">
          <h1 className="text-3xl font-extrabold tracking-tight">{actionTitle(ir)}</h1>
          <p className="text-3xl font-extrabold">{money(ir.amount.value)}</p>
        </div>
        <p className="mt-2 text-muted">
          Paid by {r.delegate} for {r.principal}, under Mandate {r.mandate.id} v{r.mandate.version}.
        </p>
        <p data-testid="scale-note" className="mt-2 text-[13px] text-muted">
          Cardano preprod · Amounts shown at 1/1000 demo scale
        </p>
      </header>

      <ol className="space-y-4 border-l-[3px] border-fg pl-5">
        <Evidence title="Invoice">
          <span className="font-mono text-[13px]">{ir.reference?.invoice_number ?? 'no invoice'}</span> from{' '}
          {ir.counterparty.display}, at the configured Stripe source
        </Evidence>
        <Evidence title="Invoice check">
          {r.verification ? (
            <>
              Report attributed to Chainlink CRE{' '}
              <span className="font-mono text-[13px]">{shortHex(r.verification.report_hash)}</span>,{' '}
              <a className="underline" href={sepoliaTxUrl(r.verification.sepolia_tx)} target="_blank" rel="noreferrer">
                Sepolia tx ↗
              </a>
            </>
          ) : (
            'Not required'
          )}
        </Evidence>
        <Evidence title="CFO approval">
          {r.approval.required ? (
            <>
              Co-signed by key <span className="font-mono text-[13px]">{shortHex(r.approval.cfo_key_hash ?? '')}</span>
            </>
          ) : (
            'Not required (within the autonomous limit)'
          )}
        </Evidence>
        {r.approval.brief_hash ? (
          <Evidence title="Decision brief">
            <span data-testid="brief-hash" className="font-mono text-[13px] break-all">
              {r.approval.brief_hash}
            </span>
            {b.brief ? ' · the brief the CFO read is attached; Verify recomputes its hash here' : ' · brief not attached'}
            {checks?.find((c) => c.id === 'brief_hash') ? (
              <span className="ml-2 inline-flex items-center gap-1">
                <span aria-hidden className={`inline-block size-2 rounded-full ${DOT[checks.find((c) => c.id === 'brief_hash')!.status]}`} />
                {checks.find((c) => c.id === 'brief_hash')!.status === 'pass' ? 'recomputed' : 'does not match'}
              </span>
            ) : null}
          </Evidence>
        ) : null}
        {r.approval.bond ? (
          <Evidence title="Escalation bond">
            <span data-testid="receipt-bond" data-status={r.approval.bond.status}>
              {BOND_TEXT[r.approval.bond.status]}, {bondAmount(r.approval.bond)}
            </span>
            {(r.approval.bond.outcome_tx_hash ?? r.approval.bond.tx_hash) ? (
              <>
                {', '}
                <a className="underline" href={cardanoscanTxUrl((r.approval.bond.outcome_tx_hash ?? r.approval.bond.tx_hash) as string)} target="_blank" rel="noreferrer">
                  escrow tx ↗
                </a>
              </>
            ) : null}
          </Evidence>
        ) : null}
        <Evidence title="Authorization">
          nonce {r.authorization.nonce}, valid until {new Date(r.authorization.valid_until).toISOString()}, digest{' '}
          <span className="font-mono text-[13px]">{shortHex(r.authorization.digest)}</span>
        </Evidence>
        <Evidence title="Masumi record">{r.masumi ? 'Recorded' : 'Not sold through Masumi'}</Evidence>
      </ol>

      <section aria-label="Cardano settlement" data-testid="settlement">
        <h2 className="text-sm font-extrabold tracking-wide">CARDANO SETTLEMENT</h2>
        <p className="mt-1 font-mono text-[13px]">tx {shortHex(tx, 4, 4)}</p>
        <ul className="mt-3 space-y-1">{(['tx', 'metadata', 'authorization', 'receipt'] as const).map(line)}</ul>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn-strong" onClick={verify} disabled={running}>
            {running ? 'Checking…' : 'Verify independently'}
          </button>
          <a className="btn" href={cardanoTxUrl(tx)} target="_blank" rel="noreferrer">
            View on Cexplorer ↗
          </a>
        </div>
        <p data-testid="data-source" className="mt-2 text-sm text-muted">
          Data source: {dataSource.cardano}
        </p>
      </section>

      {r.verification ? (
        <section aria-label="Invoice check">
          <h2 className="text-sm font-extrabold tracking-wide">INVOICE CHECK</h2>
          <ul className="mt-2 space-y-1">{line('cre')}</ul>
          <p className="mt-2 text-sm text-muted">Data source: {dataSource.sepolia}</p>
        </section>
      ) : null}

      {v ? (
        <section aria-label="Result">
          <p data-testid="verify-result" data-result={v.result} className={`text-2xl font-extrabold ${RESULT[v.result]}`}>
            {v.text}
          </p>
          {v.result === 'unavailable' ? (
            <a className="mt-1 inline-block underline" href={cardanoTxUrl(tx)} target="_blank" rel="noreferrer">
              Check the transaction on Cexplorer ↗
            </a>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Every hash and signature was recomputed in this browser with the same code the engine uses, against chain
              data read from the sources above. Our API was not consulted.
            </p>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-semibold">All {checks?.length} checks</summary>
            <ul className="mt-2 space-y-1 text-sm">
              {checks?.map((c) => (
                <li key={c.id} data-testid={`check-${c.id}`} data-status={c.status} className="flex items-start gap-2">
                  <span aria-hidden className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${DOT[c.status]}`} />
                  <span className="text-fg">
                    {c.label}
                    <code className="ml-2 font-mono text-[12px] break-all text-muted">{c.detail}</code>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
    </article>
  );
}

function Evidence({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li>
      <p className="font-bold">{title}</p>
      <p className="text-sm text-muted">{children}</p>
    </li>
  );
}
