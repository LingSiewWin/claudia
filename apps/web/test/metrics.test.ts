import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../lib/contract';
import { budgetExhausted, decisionOf, emptyRun, enforcedRow, metricsOf, reduceRun, statusLine } from '../lib/run';
import { recorded, stage } from './load';

const lab = (attack: string) => reduceRun(recorded.logs[`run-lab-${attack}`] ?? []);

describe('metrics computed from events (REPLAY and the fixture API agree)', () => {
  it('counts the stage run: 7 evaluated, 2 escalations, both bonds refunded', () => {
    const view = reduceRun(stage());
    const m = metricsOf(view);
    expect(view.cards.map(decisionOf)).toEqual(['ALLOW', 'ESCALATE', 'ESCALATE', 'DENY', 'DENY', 'DENY', 'DENY']);
    expect(m).toMatchObject({
      actions_evaluated: 7,
      allow: 1,
      escalate: 2,
      deny: 4,
      interruptions_per_100_actions: 28.6,
      bonds: { required: 2, locked: 2, refunded: 2, captured: 0 },
      budget_exhausted: 0,
    });
    expect(m.median_decision_ms).toBe(8_000);
  });

  it('matches what the fixture API serves for the mandate', () => {
    const events = recorded.runs
      .filter((r) => r.mandate_id === 'M-001')
      .flatMap((r) => recorded.logs[r.run_id] ?? [])
      .sort((a, b) => a.seq - b.seq);
    expect(metricsOf(reduceRun(events))).toEqual(recorded.metrics['M-001']);
  });

  it('escalation spam: three humans paged, three bonds captured, the fourth denied without a page', () => {
    const v = lab('escalation_spam');
    expect(v.cards.map((c) => c.state)).toEqual(['DENIED', 'DENIED', 'DENIED', 'DENIED']);
    expect(v.cards.map((c) => c.bond?.status ?? null)).toEqual(['captured', 'captured', 'captured', null]);
    expect(v.cards.map((c) => c.approval?.declineReason ?? null)).toEqual(['frivolous', 'frivolous', 'frivolous', null]);
    const last = v.cards[3]!;
    expect(last.denied).toEqual({ reason: 'INTERRUPT_BUDGET_EXHAUSTED', layer: 'engine' });
    expect(budgetExhausted(last)).toBe(true);
    expect(statusLine(last).text).toBe('Stopped by the mandate');
    expect(metricsOf(v)).toMatchObject({
      actions_evaluated: 4,
      escalate: 3,
      deny: 1,
      interruptions_per_100_actions: 75,
      bonds: { required: 3, locked: 3, refunded: 0, captured: 3 },
      budget_exhausted: 1,
    });
    expect(v.attacks.escalation_spam).toMatchObject({ stopped_by: 'engine', code: 'INTERRUPT_BUDGET_EXHAUSTED', funds_moved: '0' });
  });

  it('no bond: the 402 is the last thing that happens and the inbox stays empty', () => {
    const v = lab('no_bond');
    const card = v.cards[0]!;
    expect(card.state).toBe('ESCALATED');
    expect(statusLine(card).text).toBe('Escalated. The agent must lock a bond before the CFO is paged');
    expect(enforcedRow(card).value).toBe('Waiting for bond');
    expect(card.bond).toMatchObject({ status: 'required', tx_hash: null, amount: '5000000', asset: 'ADA' });
    expect(card.approval).toBeNull();
    expect(metricsOf(v)).toMatchObject({ escalate: 1, interruptions_per_100_actions: 0, bonds: { required: 1, locked: 0 }, actions_evaluated: 1 });
    expect(recorded.approvals.map((a) => a.approval_id)).toEqual(['AP-A-0002']);
  });

  it('walks a bond through required, locked and refunded with the outcome transaction', () => {
    const events = stage().filter((e) => e.action_id === 'A-0002' || e.type === 'RunStarted');
    let v = emptyRun();
    const seen: string[] = [];
    for (const e of events) {
      v = reduceRun([...stage().filter((x) => x.seq < e.seq && (x.action_id === 'A-0002' || x.type === 'RunStarted')), e]);
      const status = v.cards[0]?.bond?.status ?? '-';
      if (seen[seen.length - 1] !== status) seen.push(status);
    }
    expect(seen).toEqual(['-', 'required', 'locked', 'refunded']);
    expect(v.cards[0]!.bond!.outcome_tx_hash).toMatch(/^(b1){31}\d{2}$/);
    expect(v.cards[0]!.bond!.tx_hash).toMatch(/^(b0){31}\d{2}$/);
  });

  it('a budget denial counts even with a corrupt later event, and a duplicate never double counts', () => {
    const events = recorded.logs['run-lab-escalation_spam']!;
    const denied = events.find((e) => e.type === 'ActionDenied')!;
    const v = reduceRun(events);
    expect(reduceRun([...events, denied]).tally).toEqual(v.tally);
    const alien = { ...denied, seq: v.lastSeq + 1, type: 'BondCaptured', payload: undefined } as unknown as RunEvent;
    expect(reduceRun([...events, alien]).tally).toEqual(v.tally);
  });

  it('reports zero interruptions per 100 for an empty view', () => {
    expect(metricsOf(emptyRun())).toEqual({
      actions_evaluated: 0,
      allow: 0,
      deny: 0,
      escalate: 0,
      interruptions_per_100_actions: 0,
      bonds: { required: 0, locked: 0, refunded: 0, captured: 0 },
      budget_exhausted: 0,
      median_decision_ms: null,
    });
  });
});
