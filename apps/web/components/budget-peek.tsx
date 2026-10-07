'use client';
import Link from 'next/link';
import { getAuthority } from '../lib/api';
import { config } from '../lib/config';
import { bondAmount } from '../lib/format';
import { useLoad } from '../lib/hooks';

/** The CFO's interrupt budget for the stage mandate, as the authority endpoint reports it right now. */
export function BudgetPeek() {
  const { data, error } = useLoad(() => getAuthority('CFO', config.stageMandateId), []);
  if (error || !data) {
    return (
      <p data-testid="budget-peek" className="text-muted">
        {error ? 'The authority endpoint is unavailable right now.' : 'Reading the authority endpoint…'}
      </p>
    );
  }
  const { used, per_day } = data.interrupt_budget;
  return (
    <div data-testid="budget-peek" className="rounded-[10px] border border-line bg-raised p-4">
      <p className="text-sm text-muted">
        {data.approver} · Mandate {data.mandate_id} · today (UTC)
      </p>
      <div className="mt-2 flex items-center gap-1.5" aria-label={`${used} of ${per_day} interruptions used`}>
        {Array.from({ length: per_day }, (_, i) => (
          <span key={i} aria-hidden className={`h-6 flex-1 rounded-[4px] ${i < used ? 'bg-cosign' : 'border border-line bg-surface'}`} />
        ))}
      </div>
      <p className="mt-2 text-[15px]">
        <span className="font-extrabold tabular-nums">
          {Math.max(0, per_day - used)} of {per_day}
        </span>{' '}
        interruptions left. Each costs the agent {bondAmount(data.price)} in escrow.{' '}
        {data.availability === 'open' ? 'The door is open.' : 'Budget spent: escalations are denied and nobody is paged.'}
      </p>
      <p className="mt-2 text-sm text-muted">
        <Link href={`/authority/CFO?mandate_id=${encodeURIComponent(data.mandate_id)}`} className="underline">
          The authority endpoint agents read
        </Link>
      </p>
    </div>
  );
}
