import { describe, expect, it } from 'vitest';
import { crateOf, floorOf, focusOf, stamp, stationsOf, stepsOf } from '../components/floor/model';
import type { RunEvent } from '../lib/contract';
import { applyEvent, emptyRun, reduceRun } from '../lib/run';
import { recorded, stage } from './load';

const spam = (): RunEvent[] => structuredClone(recorded.logs['run-lab-escalation_spam'] ?? []);
const upTo = (events: RunEvent[], type: RunEvent['type'], actionId: string) => {
  const end = events.findIndex((e) => e.type === type && e.action_id === actionId);
  return events.slice(0, end + 1).reduce(applyEvent, emptyRun());
};

describe('floor: crates follow the reducer', () => {
  it('stage run ends with two receipts on the ledger, one refund home, four bounced at the gate or tower', () => {
    const f = floorOf(reduceRun(stage()), null);
    expect(f.crates.map((c) => [c.id, c.station, c.tone, c.bounced])).toEqual([
      ['A-0001', 'ledger', 'permit', false],
      ['A-0002', 'ledger', 'permit', false],
      ['A-0003', 'agent', 'forbid', true],
      ['A-0004', 'agent', 'forbid', true],
      ['A-0005', 'agent', 'forbid', true],
      ['A-0006', 'agent', 'forbid', true],
      ['A-0007', 'agent', 'forbid', true],
    ]);
    expect(f.stations.ledger).toBe(2);
    expect(f.stations.escrow).toEqual({ locked: 0, refunded: 2, captured: 0 });
    expect(f.stations.desk).toBeNull();
  });

  it('escalation spam: three captured crates in the sink, the fourth denied at the gate with nobody paged', () => {
    const f = floorOf(reduceRun(spam()), null);
    expect(f.crates.map((c) => c.station)).toEqual(['sink', 'sink', 'sink', 'agent']);
    expect(f.crates.every((c) => c.tone === 'forbid')).toBe(true);
    expect(f.stations.escrow).toEqual({ locked: 0, refunded: 0, captured: 3 });
    expect(f.stations.gate).toBe('DENY');
    expect(f.stations.ledger).toBe(0);
  });

  it('walks one escalated crate through every station as events arrive', () => {
    const ev = spam();
    const at = (type: RunEvent['type']) => crateOf(upTo(ev, type, 'LAB-spam-1').cards[0]!);
    expect(at('ActionProposed').station).toBe('agent');
    expect(at('AuthorityEvaluationStarted').station).toBe('gate');
    expect(at('CREVerificationStarted').station).toBe('tower');
    expect(stationsOf(upTo(ev, 'CREVerificationStarted', 'LAB-spam-1')).tower).toBe('scanning');
    expect(stationsOf(upTo(ev, 'CREVerificationCompleted', 'LAB-spam-1')).tower).toBe('idle');
    expect(at('BondRequired')).toMatchObject({ station: 'escrow', tone: 'cosign' });
    expect(stationsOf(upTo(ev, 'BondRequired', 'LAB-spam-1')).escrow.locked).toBe(0);
    expect(stationsOf(upTo(ev, 'BondLocked', 'LAB-spam-1')).escrow.locked).toBe(1);
    expect(at('ApprovalRequested').station).toBe('desk');
    expect(stationsOf(upTo(ev, 'ApprovalRequested', 'LAB-spam-1')).desk).toBe('LAB-spam-1');
    expect(at('CFODeclined')).toMatchObject({ station: 'agent', tone: 'forbid' });
    expect(at('BondCaptured')).toMatchObject({ station: 'sink', bounced: false });
  });

  it('an allowed crate goes gate -> tower -> vault -> ledger and the vault releases on settlement', () => {
    const ev = stage();
    const at = (type: RunEvent['type']) => crateOf(upTo(ev, type, 'A-0001').cards[0]!);
    expect(at('AuthorizationIssued')).toMatchObject({ station: 'vault', tone: 'permit' });
    expect(stationsOf(upTo(ev, 'TransactionSubmitted', 'A-0001')).vault).toBe('releasing');
    expect(stationsOf(upTo(ev, 'AuthorizationIssued', 'A-0001')).vault).toBe('idle');
    expect(at('ReceiptProven').station).toBe('ledger');
    expect(stationsOf(upTo(ev, 'ReceiptProven', 'A-0001')).ledger).toBe(1);
  });
});

describe('floor: step tracker', () => {
  it('reads a proven, approved payment', () => {
    const c = reduceRun(stage()).cards.find((x) => x.actionId === 'A-0002')!;
    expect(stepsOf(c).map((s) => [s.step, s.status, s.note])).toEqual([
      ['proposed', 'done', null],
      ['evaluated', 'done', 'ESCALATE'],
      ['verified', 'done', 'Chainlink CRE'],
      ['bond', 'done', 'bond refunded'],
      ['human', 'done', 'approved'],
      ['settled', 'done', null],
      ['proven', 'done', 'R-0002'],
    ]);
    const at = stepsOf(c).map((s) => s.at);
    expect(at[0]).toBe('2026-10-07T03:00:36.900Z');
    expect(at[4]).toBe('2026-10-07T03:01:00.400Z');
    expect(at[5]).toBe('2026-10-07T03:01:33.300Z');
  });

  it('reads a denial at the gate as failed evaluation and skipped everything after', () => {
    const c = reduceRun(stage()).cards.find((x) => x.actionId === 'A-0004')!;
    expect(stepsOf(c).map((s) => s.status)).toEqual(['done', 'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(stepsOf(c)[1]?.note).toBe('AMOUNT_ABOVE_HARD_CAP');
  });

  it('reads a frivolous escalation: bond required then captured, human declined', () => {
    const c = reduceRun(spam()).cards[0]!;
    const s = stepsOf(c);
    expect(s.map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'failed', 'skipped', 'skipped']);
    expect(s[3]?.note).toBe('bond captured');
    expect(s[4]?.note).toBe('declined, frivolous');
  });

  it('marks the live step while it runs and the autonomous path as skipping the human', () => {
    const ev = stage();
    const mid = upTo(ev, 'CREVerificationStarted', 'A-0001').cards[0]!;
    expect(stepsOf(mid).map((s) => s.status)).toEqual(['done', 'done', 'current', 'pending', 'pending', 'pending', 'pending']);
    const paid = upTo(ev, 'TransactionSubmitted', 'A-0001').cards[0]!;
    expect(stepsOf(paid).map((s) => s.status)).toEqual(['done', 'done', 'done', 'skipped', 'skipped', 'current', 'pending']);
    expect(stepsOf(paid)[4]?.note).toBe('autonomous');
  });

  it('stamps each step once, with the time of the event that moved it', () => {
    const ev = stage();
    let view = emptyRun();
    let stamps = {};
    for (const e of ev.slice(0, 13)) {
      view = applyEvent(view, e);
      stamps = stamp(stamps, view);
    }
    const s = stepsOf(view.cards[0]!, (stamps as Record<string, Record<string, string>>)['A-0001']);
    expect(s.map((x) => x.at)).toEqual([
      '2026-10-07T03:00:02.100Z',
      '2026-10-07T03:00:02.400Z',
      '2026-10-07T03:00:02.900Z',
      null,
      null,
      '2026-10-07T03:00:34.900Z',
      '2026-10-07T03:00:35.400Z',
    ]);
    expect(stamp(stamps, view)).toBe(stamps);
  });

  it('focuses the last moving crate, else the caller’s pick, else the last crate', () => {
    const ev = spam();
    const mid = upTo(ev, 'ActionProposed', 'LAB-spam-2');
    expect(focusOf(mid, null)?.actionId).toBe('LAB-spam-2');
    expect(focusOf(mid, 'LAB-spam-1')?.actionId).toBe('LAB-spam-1');
    expect(focusOf(reduceRun(ev), 'nope')?.actionId).toBe('LAB-spam-4');
    expect(focusOf(emptyRun(), null)).toBeNull();
  });
});
