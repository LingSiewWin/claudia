import { canonicalJson, concatBytes, hexToBytes, sha256Hex, utf8ToBytes } from '@authority/core';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../lib/contract';
import { formatUnits } from '../lib/format';
import type { KoiosTx } from '../lib/chain';
import {
  REPLAY_FAILED,
  REPLAY_UNANCHORED,
  REPLAY_VERIFIED,
  logIntact,
  readAnchor,
  replayDelays,
  replayPlan,
  replayVerifiedThrough,
  unanchoredActions,
} from '../lib/replay';
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
    const cre = 'Invoice confirmed by Chainlink CRE';
    expect(rows('A-0001')).toEqual(['ALLOW', cre, 'SETTLED']);
    expect(rows('A-0002')).toEqual(['REQUIRES APPROVAL', cre, 'SETTLED']);
    expect(rows('A-0003')).toEqual(['REQUIRES APPROVAL', cre, 'Not reached']);
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

/** Recompute every hash after an edit: a self-consistent forgery, which only an anchor can expose. */
function rehash(events: RunEvent[]): RunEvent[] {
  let prev = '00'.repeat(32);
  return events.map((e) => {
    const { hash: _h, prev_hash: _p, ...body } = e;
    const hash = sha256Hex(concatBytes(hexToBytes(prev), utf8ToBytes(canonicalJson(body))));
    const out = { ...body, hash, prev_hash: prev } as RunEvent;
    prev = hash;
    return out;
  });
}
const forged = () => {
  const edited = stage();
  const e = edited.find((x) => x.type === 'ActionProposed')!;
  if (e.type === 'ActionProposed') e.payload.action.amount.value = '84200000';
  return rehash(edited);
};
const anchorOf = (events: RunEvent[]) => ({ seq: events[events.length - 1]!.seq, head: events[events.length - 1]!.hash });

describe('REPLAY banner', () => {
  it('is VERIFIED only when the log is consistent and matches the on-chain anchor', () => {
    const events = stage();
    const plan = replayPlan(events, anchorOf(events));
    expect(plan).toMatchObject({ verified: true, banner: REPLAY_VERIFIED, anchoredThrough: events.length });
    expect(plan.events).toHaveLength(events.length);
    expect(plan.delays).toHaveLength(events.length);
  });
  it('plays under a weaker banner when nothing anchors the log', () => {
    const plan = replayPlan(stage(), null);
    expect(plan).toMatchObject({ verified: false, banner: REPLAY_UNANCHORED, anchoredThrough: null });
    expect(plan.events).toHaveLength(stage().length);
  });
  it('marks events after the anchor as unanchored', () => {
    const events = stage();
    const mid = events[10]!;
    const plan = replayPlan(events, { seq: mid.seq, head: mid.hash });
    expect(plan).toMatchObject({ verified: true, anchoredThrough: mid.seq });
    expect(plan.events).toHaveLength(events.length);
  });
  it('never shows the full VERIFIED banner over an unanchored tail', () => {
    const events = stage();
    const mid = events[10]!;
    const plan = replayPlan(events, { seq: mid.seq, head: mid.hash });
    expect(plan.banner).toBe('REPLAY — VERIFIED THROUGH EVENT 11 · LATER EVENTS NOT ANCHORED');
    expect(plan.banner).toBe(replayVerifiedThrough(11));
    expect(replayPlan(events.slice(0, 11), { seq: mid.seq, head: mid.hash }).banner).toBe(REPLAY_VERIFIED);
  });
  it('fails a forged but self-consistent chain against the anchor and plays nothing', () => {
    const real = stage();
    const fake = forged();
    expect(logIntact(fake)).toBe(true);
    expect(replayPlan(fake, anchorOf(real))).toEqual({ verified: false, banner: REPLAY_FAILED, events: [], delays: [], anchoredThrough: null });
  });
  it('shows the same forged chain as not anchored when there is no anchor', () => {
    expect(replayPlan(forged(), null).banner).toBe(REPLAY_UNANCHORED);
  });
  it('fails a log truncated at the end against the anchor', () => {
    const real = stage();
    const plan = replayPlan(real.slice(0, -3), anchorOf(real));
    expect(plan).toMatchObject({ verified: false, banner: REPLAY_FAILED, events: [] });
  });
  it('reports a failed verification and plays nothing for an edited event', () => {
    const edited = stage();
    const e = edited.find((x) => x.type === 'ActionProposed')!;
    if (e.type === 'ActionProposed') e.payload.action.amount.value = '84200000';
    expect(replayPlan(edited, anchorOf(stage()))).toMatchObject({ banner: 'REPLAY — EVIDENCE LOG FAILED VERIFICATION', events: [] });
    expect(REPLAY_FAILED).toBe('REPLAY — EVIDENCE LOG FAILED VERIFICATION');
  });
  it('never verifies an empty log', () => {
    expect(logIntact([])).toBe(false);
    expect(replayPlan([], null).banner).toBe(REPLAY_FAILED);
  });
  it('rejects a log whose head prefix was dropped', () => {
    expect(logIntact(stage().slice(4))).toBe(false);
    expect(logIntact(stage().slice(4), false)).toBe(true);
  });
  it('rejects a log with a broken link between events', () => {
    const cut = stage();
    cut.splice(3, 1);
    expect(logIntact(cut)).toBe(false);
  });
});

const koios = async (txHash: string): Promise<KoiosTx | null> => structuredClone(recorded.koios[txHash] ?? null);
const withHead = (logHead: unknown) => async (txHash: string): Promise<KoiosTx | null> => {
  const tx = structuredClone(recorded.koios[txHash]!);
  tx.metadata = { '1694': { ...(tx.metadata?.['1694'] as object), log_head: logHead } };
  return tx;
};

describe('REPLAY anchor read from Cardano', () => {
  it('pairs the latest settlement log head with that settlement event', async () => {
    const events = stage();
    const anchor = await readAnchor(events, koios);
    expect(anchor).toEqual({ seq: 30, head: events[29]!.hash });
    const plan = replayPlan(events, anchor);
    expect(plan).toMatchObject({ verified: true, banner: replayVerifiedThrough(30), anchoredThrough: 30 });
    expect(replayPlan(events.slice(0, 30), anchor).banner).toBe(REPLAY_VERIFIED);
  });
  it('accepts a log head that names its own sequence number', async () => {
    const events = stage();
    const last = events[events.length - 1]!;
    const anchor = await readAnchor(events, withHead({ seq: last.seq, hash: last.hash }));
    expect(anchor).toEqual({ seq: 60, head: last.hash });
    expect(replayPlan(events, anchor).banner).toBe(REPLAY_VERIFIED);
  });
  it('reads no anchor when the run never settled, the chain does not answer, or the metadata has no head', async () => {
    const unsettled = stage().filter((e) => e.type !== 'TransactionConfirmed');
    expect(await readAnchor(unsettled, koios)).toBeNull();
    expect(await readAnchor(stage(), async () => null)).toBeNull();
    expect(await readAnchor(stage(), () => Promise.reject(new Error('relay down')))).toBeNull();
    for (const head of [undefined, null, 42, { seq: '30', hash: 'ab' }, { seq: 30 }]) {
      expect(await readAnchor(stage(), withHead(head))).toBeNull();
    }
  });
  it('fails the replay when the on-chain head disagrees with the stored log', async () => {
    const anchor = await readAnchor(stage(), withHead('ff'.repeat(32)));
    expect(replayPlan(stage(), anchor).banner).toBe(REPLAY_FAILED);
  });
  it('lists the actions whose evidence runs past the anchor', () => {
    expect([...unanchoredActions(stage(), 30)]).toEqual(['A-0002', 'A-0003', 'A-0004', 'A-0005', 'A-0006', 'A-0007']);
    expect([...unanchoredActions(stage(), 60)]).toEqual([]);
    expect([...unanchoredActions(stage(), null)]).toEqual([]);
  });
});

describe('run reducer on damaged input', () => {
  it('counts a corrupt payload as ignored instead of throwing', () => {
    const events = stage();
    const before = events.slice(0, 5).reduce(applyEvent, emptyRun());
    const bad = { ...(events[5] as RunEvent), seq: 99, type: 'AuthorizationIssued', payload: undefined } as unknown as RunEvent;
    expect(applyEvent(before, bad)).toEqual({ ...before, ignored: before.ignored + 1 });
    const badAmount = structuredClone(events.find((x) => x.type === 'AuthorizationIssued')!) as RunEvent;
    if (badAmount.type === 'AuthorizationIssued') badAmount.payload.authorization.fields.amount = '8.42';
    expect(() => applyEvent(before, { ...badAmount, seq: 99 })).not.toThrow();
    expect(applyEvent(before, { ...badAmount, seq: 99 }).ignored).toBe(before.ignored + 1);
  });
  it('ignores a late proposal for an action already past PROPOSED', () => {
    const events = stage();
    const v = reduceRun(events);
    const proposal = events.find((x) => x.type === 'ActionProposed')!;
    const late = applyEvent(v, { ...proposal, seq: v.lastSeq + 1 } as RunEvent);
    expect(late.cards).toEqual(v.cards);
  });
  it('flags a skipped sequence number', () => {
    const events = stage();
    expect(reduceRun(events).gap).toBe(false);
    expect(reduceRun(events.filter((e) => e.seq !== 4)).gap).toBe(true);
  });
  it('flags a stream that does not begin at the start of the run', () => {
    expect(reduceRun(stage().slice(1)).gap).toBe(true);
    expect(reduceRun(recorded.logs['run-lab-recipient_swap']!).gap).toBe(false);
  });
  it('accepts only plain integer strings for amounts', () => {
    const events = stage();
    const before = events.slice(0, 5).reduce(applyEvent, emptyRun());
    for (const amount of ['', '0x10', '1e3', ' 8', '8.42']) {
      const auth = structuredClone(events.find((x) => x.type === 'AuthorizationIssued')!) as RunEvent;
      if (auth.type === 'AuthorizationIssued') auth.payload.authorization.fields.amount = amount;
      expect(applyEvent(before, { ...auth, seq: 99 }).ignored, amount).toBe(before.ignored + 1);
      const proposal = structuredClone(events.find((x) => x.type === 'ActionProposed')!) as RunEvent;
      if (proposal.type === 'ActionProposed') proposal.payload.action.amount.value = amount;
      expect(applyEvent(before, { ...proposal, seq: 99, action_id: 'A-9999' }).ignored, amount).toBe(before.ignored + 1);
    }
    const started = structuredClone(events[0]!) as RunEvent;
    if (started.type === 'RunStarted') started.payload.limits.hard_cap = '0x10';
    expect(applyEvent(emptyRun(), started)).toMatchObject({ started: null, ignored: 1 });
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