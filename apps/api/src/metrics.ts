import type { Sql } from '@authority/db';

export interface Metrics {
  actions_evaluated: number;
  allow: number;
  deny: number;
  escalate: number;
  /** ApprovalRequested per 100 evaluated actions, one decimal. */
  interruptions_per_100_actions: number;
  bonds: { required: number; locked: number; refunded: number; captured: number };
  budget_exhausted: number;
  /** Median ActionProposed -> final AuthorityEvaluated, in ms; null before any action was decided. */
  median_decision_ms: number | null;
}

const TYPES = ['ActionProposed', 'AuthorityEvaluated', 'ApprovalRequested', 'BondRequired', 'BondLocked', 'BondRefunded', 'BondCaptured', 'ActionDenied'];

/** Computed from the evidence log alone, so anyone holding the log reproduces the same numbers. */
export async function metricsFor(q: Sql, mandateId: string): Promise<Metrics> {
  // ponytail: full scan of the mandate's events per call; fold incrementally if the log outgrows a demo.
  const rows = await q.query<{ run_id: string; action_id: string | null; type: string; payload: string; created_ms: string }>(
    `select e.run_id::text as run_id, e.action_id, e.type, e.payload, (extract(epoch from e.created_at) * 1000)::bigint::text as created_ms
       from events e join runs r on r.run_id = e.run_id
      where r.mandate_id = $1 and e.type = any($2::text[]) order by e.seq`,
    [mandateId, TYPES],
  );
  const actions = new Map<string, { proposed_ms: number | null; outcome: string | null; decided_ms: number | null }>();
  const counts = { interruptions: 0, required: 0, locked: 0, refunded: 0, captured: 0, budget_exhausted: 0 };
  for (const r of rows) {
    const key = `${r.run_id}/${r.action_id ?? ''}`;
    const ms = Number(r.created_ms);
    const a = actions.get(key) ?? { proposed_ms: null, outcome: null, decided_ms: null };
    switch (r.type) {
      case 'ActionProposed':
        a.proposed_ms ??= ms;
        actions.set(key, a);
        break;
      case 'AuthorityEvaluated': {
        const outcome = (JSON.parse(r.payload) as { evaluation: { outcome: string } }).evaluation.outcome;
        if (outcome !== 'NEEDS_VERIFICATION') {
          a.outcome = outcome;
          a.decided_ms = ms;
          actions.set(key, a);
        }
        break;
      }
      case 'ApprovalRequested':
        counts.interruptions += 1;
        break;
      case 'BondRequired':
        counts.required += 1;
        break;
      case 'BondLocked':
        counts.locked += 1;
        break;
      case 'BondRefunded':
        counts.refunded += 1;
        break;
      case 'BondCaptured':
        counts.captured += 1;
        break;
      case 'ActionDenied':
        if ((JSON.parse(r.payload) as { reason: string }).reason === 'INTERRUPT_BUDGET_EXHAUSTED') counts.budget_exhausted += 1;
        break;
    }
  }
  const decided = [...actions.values()].filter((a) => a.outcome !== null);
  const tally = (o: string) => decided.filter((a) => a.outcome === o).length;
  const durations = decided
    .filter((a) => a.proposed_ms !== null && a.decided_ms !== null)
    .map((a) => a.decided_ms! - a.proposed_ms!)
    .sort((x, y) => x - y);
  const mid = durations.length >> 1;
  const median = durations.length === 0 ? null : durations.length % 2 ? durations[mid]! : Math.round((durations[mid - 1]! + durations[mid]!) / 2);
  return {
    actions_evaluated: decided.length,
    allow: tally('ALLOW'),
    deny: tally('DENY'),
    escalate: tally('ESCALATE'),
    interruptions_per_100_actions: decided.length === 0 ? 0 : Math.round((counts.interruptions / decided.length) * 1000) / 10,
    bonds: { required: counts.required, locked: counts.locked, refunded: counts.refunded, captured: counts.captured },
    budget_exhausted: counts.budget_exhausted,
    median_decision_ms: median,
  };
}
