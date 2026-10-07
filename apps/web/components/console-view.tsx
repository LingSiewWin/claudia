'use client';
import { bytesToHex, utf8ToBytes } from '@authority/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  approve,
  decline,
  execute,
  getMandate,
  listReceipts,
  pendingApprovals,
  prepareRevoke,
  prepareUpdate,
  submitMandateTx,
} from '../lib/api';
import { type ConnectedWallet, type WalletChoice, connectWallet, injectedWallets, walletErrorText } from '../lib/cip30';
import { cardanoTxUrl } from '../lib/config';
import { type ApprovalView, type MandateView, declineMessage } from '../lib/contract';
import { actionTitle, formatUnits, money, parseUnits, plainReason, shortHex } from '../lib/format';
import { useLoad } from '../lib/hooks';

const KEY_HASH = /^[0-9a-f]{56}$/;

/** Admin key on the principal, when the mandate record carries one. Absent until that field is published. */
function mandateAdminKey(principal: object | null | undefined): string | null {
  if (!principal || !('cardano_key_hash' in principal)) return null;
  const hash = (principal as { cardano_key_hash?: unknown }).cardano_key_hash;
  return typeof hash === 'string' && KEY_HASH.test(hash) ? hash : null;
}

function holds(wallet: ConnectedWallet | null, keyHash: string | null): boolean {
  return wallet !== null && wallet.networkId === 0 && keyHash !== null && wallet.keyHashes.includes(keyHash);
}

export function ConsoleView({ mandateId }: { mandateId: string }) {
  const mandate = useLoad(() => getMandate(mandateId), [mandateId]);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  // Payments are signed by the mandate approver. Revoke and update are signed by the admin key.
  const approver = mandate.data?.mandate.approvers.find((a) => a.role === 'CFO')?.cardano_key_hash ?? null;
  const admin = mandateAdminKey(mandate.data?.mandate.principal);
  const isApprover = holds(wallet, approver);
  const isAdmin = holds(wallet, admin);

  return (
    <div className="space-y-12">
      <MandateSummary m={mandate.data} error={mandate.error} />
      <WalletPanel wallet={wallet} onConnect={setWallet} approver={approver} admin={admin} isApprover={isApprover} isAdmin={isAdmin} />
      <Approvals wallet={isApprover ? wallet : null} approver={approver} />
      <Receipts mandateId={mandateId} />
      {mandate.data ? (
        <MandateControls m={mandate.data} wallet={isAdmin ? wallet : null} note={controlsNote(isAdmin, admin, wallet !== null)} onDone={mandate.reload} />
      ) : null}
    </div>
  );
}

function controlsNote(isAdmin: boolean, admin: string | null, connected: boolean): string | null {
  if (isAdmin) return null;
  if (admin === null) return 'This mandate has no admin key on record, so revoke and update stay locked.';
  if (!connected) return 'Connect the mandate admin wallet to revoke or update.';
  return 'Revoke and update are signed by the mandate admin, not this wallet.';
}

function MandateSummary({ m, error }: { m: MandateView | null; error: string | null }) {
  if (error) return <p role="alert" className="text-forbid">{error}</p>;
  if (!m) return <p className="text-muted">Loading mandate…</p>;
  const l = m.limits;
  const f = (v: string) => money(v, l.decimals);
  return (
    <section aria-label="Mandate">
      <p className="text-sm text-muted">
        Mandate {m.mandate.id} v{m.anchor.version}, {m.anchor.status}
      </p>
      <h1 className="mt-1 text-3xl font-extrabold tracking-tight">
        {m.mandate.principal.name} → {m.mandate.delegate.id}
      </h1>
      <p className="mt-2 text-muted">
        Alone up to {f(l.autonomous_limit)}. With your signature up to {f(l.hard_cap)}. At most {f(l.daily_cap)} a day. Treasury
        never below {f(l.treasury_minimum)}.{' '}
        <Link className="underline" href={`/mandate/${encodeURIComponent(m.mandate.id)}`}>
          See the boundary
        </Link>
      </p>
      <p data-testid="scale-note" className="mt-2 text-[13px] text-muted">
        Cardano preprod · Amounts shown at 1/1000 demo scale
      </p>
    </section>
  );
}

function StatusDot({ tone }: { tone: 'permit' | 'forbid' }) {
  return <span aria-hidden className={`mr-1.5 inline-block size-2 rounded-full ${tone === 'permit' ? 'bg-permit' : 'bg-forbid'}`} />;
}

function walletSentence(isApprover: boolean, isAdmin: boolean, approver: string | null, admin: string | null): string {
  if (isApprover && isAdmin) return 'You are the payment approver and the mandate admin.';
  if (isApprover) return 'You are the payment approver for this mandate.';
  if (isAdmin) return 'You are the mandate admin. Revoke and update are signed here.';
  const who = [
    approver ? `payment approver (${shortHex(approver)})` : null,
    admin ? `mandate admin (${shortHex(admin)})` : null,
  ].filter((part): part is string => part !== null);
  if (who.length === 0) return 'This mandate has no payment approver or admin key on record.';
  return `This wallet is not the ${who.join(' or the ')}.`;
}

function WalletPanel({
  wallet,
  onConnect,
  approver,
  admin,
  isApprover,
  isAdmin,
}: {
  wallet: ConnectedWallet | null;
  onConnect: (w: ConnectedWallet) => void;
  approver: string | null;
  admin: string | null;
  isApprover: boolean;
  isAdmin: boolean;
}) {
  const [choices, setChoices] = useState<WalletChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setChoices(injectedWallets()), []);
  const connect = async (key: string) => {
    setError(null);
    try {
      onConnect(await connectWallet(key));
    } catch (err) {
      setError(walletErrorText(err));
    }
  };
  const wrongNetwork = wallet !== null && wallet.networkId !== 0;
  return (
    <section aria-label="Wallet" data-testid="wallet">
      <h2 className="text-xl font-extrabold">Your wallet</h2>
      {wallet ? (
        <p className="mt-2 text-fg" data-testid="wallet-status" data-cfo={isApprover ? 'true' : 'false'} data-admin={isAdmin ? 'true' : 'false'}>
          {wallet.name} connected.{' '}
          <strong>
            <StatusDot tone={wrongNetwork || (!isApprover && !isAdmin) ? 'forbid' : 'permit'} />
            {wrongNetwork ? 'Switch the wallet to Cardano preprod.' : walletSentence(isApprover, isAdmin, approver, admin)}
          </strong>
        </p>
      ) : choices.length === 0 ? (
        <p className="mt-2 text-muted">No Cardano wallet found. Install Lace and switch it to preprod.</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-3">
          {choices.map((c) => (
            <button key={c.key} type="button" className="btn" onClick={() => connect(c.key)}>
              Connect {c.name}
            </button>
          ))}
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-forbid">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Approvals({ wallet, approver }: { wallet: ConnectedWallet | null; approver: string | null }) {
  const [items, setItems] = useState<ApprovalView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      pendingApprovals().then(
        (r) => {
          if (cancelled) return;
          setItems(r.approvals);
          setError(null);
        },
        (err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        },
      );
    load();
    const id = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return (
    <section aria-label="Approvals">
      <h2 className="text-xl font-extrabold">CFO approval</h2>
      {error ? <p role="alert" className="text-forbid">{error}</p> : null}
      {items.length === 0 ? <p className="mt-2 text-muted">No payments are waiting for approval.</p> : null}
      <ul className="mt-3 space-y-4">
        {items.map((a) => (
          <li key={a.approval_id}>
            <ApprovalCard item={a} wallet={wallet} approver={approver} />
          </li>
        ))}
      </ul>
    </section>
  );
}

type Step = 'idle' | 'authorizing' | 'signing' | 'submitting' | 'submitted' | 'declining' | 'declined' | 'error';

function ApprovalCard({ item, wallet, approver }: { item: ApprovalView; wallet: ConnectedWallet | null; approver: string | null }) {
  const [step, setStep] = useState<Step>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const a = item.action;

  const onApprove = async () => {
    if (!wallet) return;
    setMessage(null);
    try {
      setStep('authorizing');
      const prepared = await approve(item.approval_id);
      setStep('signing');
      const witness = await wallet.api.signTx(prepared.unsigned_tx_cbor, true);
      setStep('submitting');
      const done = await execute({
        approval_id: item.approval_id,
        authorization_digest: prepared.authorization.digest_hex,
        cfo_witness_cbor: witness,
      });
      setTxHash(done.tx_hash);
      setStep('submitted');
    } catch (err) {
      setStep('error');
      setMessage(walletErrorText(err));
    }
  };
  // Decline is authenticated: the approver signs declineMessage with CIP-30 signData (CIP-8).
  const onDecline = async () => {
    const address = wallet?.addresses.find((x) => x.keyHash === approver);
    if (!wallet || !address) return;
    setMessage(null);
    try {
      setStep('declining');
      const cfo = await wallet.api.signData(address.hex, bytesToHex(utf8ToBytes(declineMessage(item.approval_id))));
      await decline(item.approval_id, cfo);
      setStep('declined');
    } catch (err) {
      setStep('error');
      setMessage(walletErrorText(err, 'signData'));
    }
  };

  return (
    <article data-testid="approval" className="rounded-[10px] border border-line bg-raised p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-lg font-semibold">{actionTitle(a)}</h3>
        <p className="text-2xl font-extrabold">{money(a.amount.value)}</p>
      </div>
      <p className="font-mono text-[13px] text-muted">{a.reference?.invoice_number ?? 'No invoice'}</p>
      <p className="mt-2">
        <span className="font-semibold">Why the agent wants this: </span>
        <q>{a.rationale}</q>
      </p>
      <ul className="mt-2 border-l-[3px] border-fg pl-3 text-sm">
        {item.evaluation.approvals_required.map((r) => (
          <li key={r.constraint}>{plainReason(r.reason)}</li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-strong" onClick={onApprove} disabled={!wallet || step !== 'idle'}>
          Approve once
        </button>
        <button type="button" className="btn" onClick={onDecline} disabled={!wallet || step !== 'idle'}>
          Decline
        </button>
        {!wallet ? <span className="text-sm text-muted">Connect the payment approver wallet to approve or decline.</span> : null}
      </div>
      <p data-testid="approval-step" data-step={step} className="mt-3 text-sm">
        {step === 'authorizing' && 'Re-checking the mandate with fresh state and a fresh invoice verification…'}
        {step === 'signing' && 'Sign the release transaction in your wallet. Your signature lets the vault release above the autonomous limit.'}
        {step === 'submitting' && 'Submitting to Cardano…'}
        {step === 'declining' && 'Sign the decline in your wallet. It proves the CFO refused this payment.'}
        {step === 'submitted' && txHash ? (
          <>
            Submitted.{' '}
            <a className="font-mono text-[13px] underline" href={cardanoTxUrl(txHash)} target="_blank" rel="noreferrer">
              {shortHex(txHash)}
            </a>
          </>
        ) : null}
        {step === 'declined' && 'Declined. No money moves, and the agent is told the CFO declined.'}
        {step === 'error' && <span className="text-forbid">{message}</span>}
      </p>
    </article>
  );
}

function Receipts({ mandateId }: { mandateId: string }) {
  const { data, error } = useLoad(() => listReceipts(mandateId), [mandateId]);
  return (
    <section aria-label="Receipts">
      <h2 className="text-xl font-extrabold">Receipts</h2>
      {error ? <p role="alert" className="text-forbid">{error}</p> : null}
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {(data?.receipts ?? []).map((r) => (
          <li key={r.receipt_id} className="flex items-baseline justify-between gap-3 py-2">
            <span>{r.counterparty}</span>
            <span>{money(r.amount)}</span>
            <Link className="font-mono text-[13px] underline" href={`/receipt/${encodeURIComponent(r.receipt_id)}`}>
              {r.receipt_id}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MandateControls({
  m,
  wallet,
  note,
  onDone,
}: {
  m: MandateView;
  wallet: ConnectedWallet | null;
  note: string | null;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [form, setForm] = useState(() => ({
    autonomous_limit: formatUnits(m.limits.autonomous_limit, m.limits.decimals),
    hard_cap: formatUnits(m.limits.hard_cap, m.limits.decimals),
    daily_cap: formatUnits(m.limits.daily_cap, m.limits.decimals),
    treasury_minimum: formatUnits(m.limits.treasury_minimum, m.limits.decimals),
  }));
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const id = m.mandate.id;

  const signAndSubmit = async (prepared: { unsigned_tx_cbor: string; tx_hash: string }) => {
    if (!wallet) return;
    const witness = await wallet.api.signTx(prepared.unsigned_tx_cbor, true);
    const { tx_hash } = await submitMandateTx(id, { tx_hash: prepared.tx_hash, cfo_witness_cbor: witness });
    setStatus({ kind: 'ok', text: `Submitted anchor transaction ${tx_hash}. Older authorizations stop working once it confirms.` });
    onDone();
  };
  const revoke = async () => {
    setConfirming(false);
    try {
      await signAndSubmit(await prepareRevoke(id));
    } catch (err) {
      setStatus({ kind: 'error', text: walletErrorText(err) });
    }
  };
  const update = async () => {
    try {
      const limits = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, parseUnits(v, m.limits.decimals).toString()]),
      ) as { autonomous_limit: string; hard_cap: string; daily_cap: string; treasury_minimum: string };
      await signAndSubmit(await prepareUpdate(id, limits));
    } catch (err) {
      setStatus({ kind: 'error', text: walletErrorText(err) });
    }
  };

  return (
    <section aria-label="Change the mandate">
      <h2 className="text-xl font-extrabold">Change the mandate</h2>
      {note ? <p className="mt-2 text-muted">{note}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {confirming ? (
          <button type="button" className="btn-strong btn-danger" onClick={revoke} disabled={!wallet}>
            Confirm: revoke {id} v{m.anchor.version}
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirming(true)} disabled={!wallet || m.anchor.status === 'revoked'}>
            Revoke mandate
          </button>
        )}
      </div>
      <form
        className="mt-6 grid max-w-md grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void update();
        }}
      >
        {(Object.keys(form) as Array<keyof typeof form>).map((k) => (
          <label key={k} className="text-sm">
            <span className="text-muted">{k.replace('_', ' ')}</span>
            <input
              className="mt-1 w-full rounded-md border border-line bg-raised px-2 py-1 text-fg"
              inputMode="decimal"
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            />
          </label>
        ))}
        <button type="submit" className="btn col-span-2 justify-self-start" disabled={!wallet}>
          Update mandate to v{m.anchor.version + 1}
        </button>
      </form>
      {status ? (
        <p className={`mt-3 text-sm ${status.kind === 'error' ? 'text-forbid' : ''}`} role={status.kind === 'error' ? 'alert' : undefined}>
          {status.text}
        </p>
      ) : null}
    </section>
  );
}
