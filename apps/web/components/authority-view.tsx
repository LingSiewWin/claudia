'use client';
import Link from 'next/link';
import { getAuthority } from '../lib/api';
import { bondAmount, budgetText } from '../lib/format';
import { useLoad } from '../lib/hooks';

/**
 * The public face of one human authority endpoint: what an agent must lock to interrupt this person, how much of
 * today's attention is left, and whether the door is open. Read by agents and their operators before they escalate.
 */
export function AuthorityView({ role, mandateId }: { role: string; mandateId: string }) {
  const { data, error } = useLoad(() => getAuthority(role, mandateId), [role, mandateId]);
  if (error) return <p role="alert" className="text-forbid">{error}</p>;
  if (!data) return <p className="text-muted">Loading authority {role}…</p>;
  const open = data.availability === 'open';
  const left = Math.max(0, data.interrupt_budget.per_day - data.interrupt_budget.used);
  return (
    <article data-testid="authority-page" data-availability={data.availability} className="space-y-10">
      <header>
        <p className="text-sm text-muted">Human authority endpoint</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">
          {data.approver} for Mandate {data.mandate_id}
        </h1>
        <p className="mt-3 max-w-prose text-lg text-muted">
          Agents reach this person only by locking a bond. A reasonable request is refunded when the {data.approver} decides;
          a frivolous one is captured. Once today&apos;s interrupt budget is spent, further requests are denied and nobody is paged.
        </p>
      </header>

      <dl className="grid gap-8 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-muted">Price of an interruption</dt>
          <dd data-testid="authority-price" className="text-2xl font-extrabold tabular-nums">
            {bondAmount(data.price)}
          </dd>
          <dd className="text-sm text-muted">locked in escrow on Cardano preprod, refunded on a reasonable ask</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Budget left today</dt>
          <dd data-testid="authority-budget" className="text-2xl font-extrabold tabular-nums">
            {left} <span className="text-base font-semibold text-muted">/ {data.interrupt_budget.per_day}</span>
          </dd>
          <dd className="text-sm text-muted">{budgetText(data.interrupt_budget.used, data.interrupt_budget.per_day)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">Availability</dt>
          <dd data-testid="authority-availability" className="flex items-center gap-2 text-2xl font-extrabold">
            <span aria-hidden className={`inline-block size-2.5 rounded-full ${open ? 'bg-permit' : 'bg-forbid'}`} />
            {open ? 'Open' : 'Budget spent'}
          </dd>
          <dd className="text-sm text-muted">{open ? 'An escalation with a bond reaches the inbox' : 'Escalations are denied until tomorrow (UTC)'}</dd>
        </div>
      </dl>

      <section aria-label="How to reach this authority" className="text-[15px]">
        <h2 className="text-sm font-extrabold tracking-wide">HOW AN AGENT GETS HERE</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Propose the action to <code className="font-mono text-[13px]">POST /v1/authority/check</code>. Inside the mandate it is allowed on the spot.
          </li>
          <li>
            Outside the agent&apos;s own limit the reply is <code className="font-mono text-[13px]">402</code> with this price. Lock the bond in escrow and retry
            with the payment signature.
          </li>
          <li>The {data.approver} reads a Decision Brief and approves or declines. Approval or a reasonable decline refunds the bond.</li>
        </ol>
        <p className="mt-4 text-sm text-muted">
          <Link className="underline" href={`/mandate/${encodeURIComponent(data.mandate_id)}`}>
            See the mandate boundary
          </Link>
        </p>
      </section>
    </article>
  );
}
