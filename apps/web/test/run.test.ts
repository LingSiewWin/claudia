import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../lib/contract';
import { formatUnits } from '../lib/format';
import { REPLAY_FAILED, REPLAY_VERIFIED, logIntact, replayDelays, replayPlan } from '../lib/replay';
import { applyEvent, emptyRun, enforcedRow, mayRow, reduceRun, statusLine, treasury, trueRow } from '../lib/run';
import { recorded, stage } from './load';

describe('run reducer on the recorded stage run', () => {
  const view = reduceRun(stage());
  const byId = Object.fromEntries(view.cards.map((c) => [c.actionId, c]));

  it('builds one card per action in proposal order', () => {
    expect(view.cards.map((c) => c.actionId)).toEqual(['A-0001', 'A-0002', 'A-0003', 'A-0004', 'A-0005', 'A-0006', 'A-0007']);
    expect(view.started?.mandate_id).toBe('M-001');
  });

  it('ends each case in its expected state', () => {
    expect(view.cards.map((c) => c.state)).toEqual(['PROVEN', 'PROVEN', 'DENIED', 'DENIED', 'DENIED', 'DENIED', 'DENIED']);
    expect(view.cards.map((c) => c.denied?.reason ?? null)).toEqual([
      null,
      null,
      'PRINCIPAL_DECLINED',
      'AMOUNT_ABOVE_HARD_CAP',
      'PURPOSE_NOT_AUTHORIZED',
      'RECIPIENT_MISMATCH',
      'TREASURY_FLOOR_VIOLATION',
    ]);
  });

  it('separates MAY? / TRUE? / ENFORCED by layer', () => {
    const rows = (id: string) => {
      const c = byId[id]!;
      return [mayRow(c).value, trueRow(c).value, enforcedRow(c).value];
    };
    expect(rows('A-0001')).toEqual(['ALLOW', 'VERIFIED', 'SETTLED']);
    expect(rows('A-0002')).toEqual(['REQUIRES APPROVAL', 'VERIFIED', 'SETTLED']);
    expect(rows('A-0003')).toEqual(['REQUIRES APPROVAL', 'VERIFIED', 'Not reached']);
    expect(rows('A-0004')).toEqual(['DENY', 'Not reached', 'Not reached']);
    expect(rows('A-0005')).toEqual(['DENY', 'Not reached', 'Not reached']);
    expect(rows('A-0006')).toEqual(['ALLOW', 'MISMATCH', 'Not reached']);
    expect(rows('A-0007')).toEqual(['DENY', 'Not reached', 'Not reached']);
  });

  it('says the outcome in business words first', () => {
    expect(view.cards.map((c) => statusLine(c).text)).toEqual([
      'Paid by the agent alone · Receipt R-0001',
      'Paid with CFO approval · Receipt R-0002',
      'Stopped by the CFO',
      'Stopped by the mandate',
      'Stopped by the mandate',
      'Stopped by the invoice check',
      'Stopped by the mandate',
    ]);
  });

  it('follows treasury and daily spend from the run itself', () => {
    const t = treasury(view)!;
    expect([formatUnits(t.balance), formatUnits(t.spent)]).toEqual(['108.58', '26.42']);
  });

  it('ignores duplicate and out-of-order events (SSE reconnect replays)', () => {
    const events = stage();
    let v = emptyRun();
    for (const e of events) v = applyEvent(applyEvent(v, e), e);
    const stale = { ...(events[3] as RunEvent), seq: 2 } as RunEvent;
    v = applyEvent(v, stale);
    expect(v.cards).toEqual(view.cards);
    expect(v.ignored).toBe(events.length + 1);
  });

  it('streams incrementally to the same final view', () => {
    const events = stage();
    const half = events.slice(0, 20).reduce(applyEvent, emptyRun());
    expect(events.slice(20).reduce(applyEvent, half).cards).toEqual(view.cards);
  });
});

describe('run reducer on unknown input', () => {
  it('drops an event type it does not know and changes nothing', () => {
    const events = stage();
    const before = events.slice(0, 5).reduce(applyEvent, emptyRun());
    const alien = { ...(events[5] as RunEvent), seq: 99, type: 'SomethingNew', payload: {} } as unknown as RunEvent;
    expect(applyEvent(before, alien)).toEqual(before);
  });
});

describe('run reducer on Attack Lab runs', () => {
  const lab = (attack: string) => reduceRun(recorded.logs[`run-lab-${attack}`] ?? []);

  it.each([
    ['recipient_swap', 'R16'],
    ['amount_swap', 'R6'],
    ['replay', 'R8'],
    ['expired', 'R7'],
    ['revoked', 'R4'],
    ['daily_cap', 'R12'],
    ['cfo_bypass', 'R11'],
  ])('%s is rejected by the vault with %s and moves nothing', (attack, code) => {
    const v = lab(attack);
    const result = v.attacks[attack as keyof typeof v.attacks];
    expect(result).toMatchObject({ stopped_by: 'vault', code, funds_moved: '0' });
    const last = v.cards[v.cards.length - 1]!;
    expect(enforcedRow(last)).toMatchObject({ value: 'REJECTED', reason: code });
  });

  it('prompt injection is stopped by CRE before any transaction', () => {
    const v = lab('prompt_injection');
    expect(v.attacks.prompt_injection).toMatchObject({ stopped_by: 'cre', code: 'RECIPIENT_MISMATCH', funds_moved: '0' });
    expect(v.cards[0]!.tx.hash).toBeNull();
  });

  it('compromised-engine releases show the engine as bypassed', () => {
    const v = lab('cfo_bypass');
    expect(mayRow(v.cards[0]!).value).toBe('BYPASSED');
    expect(trueRow(v.cards[0]!).value).toBe('Not reached');
  });
});

describe('REPLAY evidence check', () => {
  it('accepts the stored log and rejects any edited event', () => {
    expect(logIntact(stage())).toBe(true);
    const edited = stage();
    const e = edited.find((x) => x.type === 'ActionProposed')!;
    if (e.type === 'ActionProposed') e.payload.action.amount.value = '84200000';
    expect(logIntact(edited)).toBe(false);
  });
});

describe('REPLAY banner', () => {
  it('is earned by an intact log, which then plays in full', () => {
    const plan = replayPlan(stage());
    expect(plan).toMatchObject({ verified: true, banner: REPLAY_VERIFIED });
    expect(plan.events).toHaveLength(stage().length);
    expect(plan.delays).toHaveLength(plan.events.length);
  });
  it('reports a failed verification and plays nothing for a tampered log', () => {
    const edited = stage();
    const e = edited.find((x) => x.type === 'ActionProposed')!;
    if (e.type === 'ActionProposed') e.payload.action.amount.value = '84200000';
    expect(replayPlan(edited)).toEqual({ verified: false, banner: 'REPLAY — EVIDENCE LOG FAILED VERIFICATION', events: [], delays: [] });
    expect(REPLAY_FAILED).toBe('REPLAY — EVIDENCE LOG FAILED VERIFICATION');
  });
  it('rejects a log with a broken link between events', () => {
    const cut = stage();
    cut.splice(3, 1);
    expect(logIntact(cut)).toBe(false);
  });
});

describe('replayDelays', () => {
  it('starts immediately and clamps recorded gaps to stage speed', () => {
    const d = replayDelays(stage());
    expect(d[0]).toBe(0);
    expect(Math.min(...d.slice(1))).toBeGreaterThanOrEqual(250);
    expect(Math.max(...d)).toBeLessThanOrEqual(1400);
  });
});