import { canonicalJson, concatBytes, hexToBytes, sha256Hex, utf8ToBytes } from '@authority/core';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../lib/contract';
import { formatUnits } from '../lib/format';
import { MANDATE_TOKEN_HEX, type KoiosTx } from '../lib/chain';
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
    expect(rows('A-0002')).toEqual(['ESCALATE', cre, 'SETTLED']);
    expect(rows('A-0003')).toEqual(['ESCALATE', cre, 'Not reached']);
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
const STAGE = 'run-stage-0001';
const indexOf = (events: RunEvent[], type: RunEvent['type']) => events.findIndex((e) => e.type === type);

describe('REPLAY banner', () => {
  it('is VERIFIED only when the anchor covers the last event of a finished run', () => {
    const events = stage();
    const plan = replayPlan(events, anchorOf(events));
    expect(plan).toMatchObject({ verdict: 'verified', verified: true, banner: REPLAY_VERIFIED, anchoredThrough: events[events.length - 1]!.seq });
    expect(plan.events).toHaveLength(events.length);
    expect(plan.delays).toHaveLength(events.length);
  });
  it('plays under a weaker banner when nothing anchors the log', () => {
    const plan = replayPlan(stage(), null);
    expect(plan).toMatchObject({ verdict: 'unanchored', verified: false, banner: REPLAY_UNANCHORED, anchoredThrough: null });
    expect(plan.events).toHaveLength(stage().length);
  });
  it('says how far an anchor short of the last event reaches', () => {
    const events = stage();
    const mid = events[10]!;
    const plan = replayPlan(events, { seq: mid.seq, head: mid.hash });
    expect(plan).toMatchObject({ verdict: 'through', verified: true, anchoredThrough: mid.seq });
    expect(plan.banner).toBe('REPLAY — VERIFIED THROUGH EVENT 11 · LATER EVENTS NOT ANCHORED');
    expect(plan.banner).toBe(replayVerifiedThrough(11));
    expect(plan.events).toHaveLength(events.length);
  });
  it('never shows the full banner for a log that stops before the run ended', () => {
    const events = stage();
    const open = events.slice(0, indexOf(events, 'AuthorizationIssued') + 1);
    expect(replayPlan(open, anchorOf(open))).toMatchObject({ verdict: 'through', banner: replayVerifiedThrough(open.length) });
    const ended = events.slice(0, indexOf(events, 'ReceiptProven') + 1);
    expect(replayPlan(ended, anchorOf(ended)).banner).toBe(REPLAY_VERIFIED);
  });
  it('fails a forged but self-consistent chain against the anchor and plays nothing', () => {
    const real = stage();
    const fake = forged();
    expect(logIntact(fake)).toBe(true);
    expect(replayPlan(fake, anchorOf(real))).toEqual({
      verdict: 'failed',
      verified: false,
      banner: REPLAY_FAILED,
      events: [],
      delays: [],
      anchoredThrough: null,
      recordedAt: null,
    });
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
  it('fails a log served for a different run than the one requested', () => {
    const events = stage();
    expect(replayPlan(events, anchorOf(events), true, STAGE).verdict).toBe('verified');
    expect(replayPlan(events, anchorOf(events), true, 'run-lab-replay')).toMatchObject({ verdict: 'failed', events: [] });
    const mixed = stage();
    mixed[5] = { ...mixed[5]!, run_id: 'run-lab-replay' };
    const relinked = rehash(mixed);
    expect(logIntact(relinked)).toBe(true);
    expect(replayPlan(relinked, null, true, STAGE)).toMatchObject({ verdict: 'failed', events: [] });
  });
  it('dates the run from its hashed RunStarted event', () => {
    const events = stage();
    expect(events[0]!.type).toBe('RunStarted');
    expect(replayPlan(events, null).recordedAt).toBe(events[0]!.created_at);
    expect(replayPlan(forged(), anchorOf(events)).recordedAt).toBeNull();
    expect(replayPlan(recorded.logs['run-lab-replay']!, null, false).recordedAt).toBe(recorded.logs['run-lab-replay']![0]!.created_at);
  });
});

const koios = async (txHash: string): Promise<KoiosTx | null> => structuredClone(recorded.koios[txHash] ?? null);
/** Chain data where one transaction's metadata 1694 carries a different log_head. */
const withHead =
  (target: string, logHead: unknown) =>
  async (txHash: string): Promise<KoiosTx | null> => {
    const tx = structuredClone(recorded.koios[txHash] ?? null);
    if (tx && txHash === target) tx.metadata = { '1694': { ...(tx.metadata?.['1694'] as object), log_head: logHead } };
    return tx;
  };
const closingTx = (runId = STAGE) => recorded.anchors[runId]!.tx_hash;
/** The events of one settlement: TransactionBuilt, TransactionSubmitted, TransactionConfirmed. */
function settlement(events: RunEvent[], which: 'first' | 'last') {
  const confirmed = (which === 'first' ? events.find : events.findLast).call(events, (e) => e.type === 'TransactionConfirmed');
  if (confirmed?.type !== 'TransactionConfirmed') throw new Error('no settlement');
  const tx = confirmed.payload.tx_hash;
  const of = (type: RunEvent['type']) => events.find((e) => e.type === type && 'tx_hash' in e.payload && e.payload.tx_hash === tx)!;
  const built = of('TransactionBuilt');
  if (built.type !== 'TransactionBuilt') throw new Error('no build');
  return { tx, built, submitted: of('TransactionSubmitted'), confirmed };
}

describe('REPLAY anchor read from Cardano', () => {
  it('reads the settlement head committed before the transaction was submitted', async () => {
    const events = stage();
    const { tx, built, submitted } = settlement(events, 'last');
    const head = (recorded.koios[tx]!.metadata!['1694'] as { log_head: { seq: number; hash: string } }).log_head;
    expect(head).toEqual(built.payload.log_head);
    expect(head.seq).toBe(built.seq - 1);
    expect(head.seq).toBeLessThan(submitted.seq);
    expect(head.hash).toBe(events.find((e) => e.seq === head.seq)!.hash);
    const anchor = await readAnchor(events, koios);
    expect(anchor).toEqual({ seq: head.seq, head: head.hash });
    expect(replayPlan(events, anchor)).toMatchObject({ verdict: 'through', banner: replayVerifiedThrough(head.seq), anchoredThrough: head.seq });
  });
  it('reads the closing anchor that covers the whole run', async () => {
    const events = stage();
    const last = events[events.length - 1]!;
    expect(recorded.anchors[STAGE]).toMatchObject({ seq: last.seq, hash: last.hash });
    const anchor = await readAnchor(events, koios, closingTx());
    expect(anchor).toEqual({ seq: last.seq, head: last.hash });
    expect(replayPlan(events, anchor, true, STAGE)).toMatchObject({ verdict: 'verified', banner: REPLAY_VERIFIED });
  });
  it('treats an unsigned closing transaction as no closing anchor', async () => {
    const events = stage();
    const { built } = settlement(events, 'last');
    const unsigned = async (h: string) => {
      const tx = structuredClone(recorded.koios[h] ?? null);
      if (tx && h === closingTx()) {
        const meta = { ...(tx.metadata?.['1694'] as object) } as { signature?: string };
        delete meta.signature;
        tx.metadata = { '1694': meta };
      }
      return tx;
    };
    expect(await readAnchor(events, unsigned, closingTx())).toEqual({
      seq: built.payload.log_head.seq,
      head: built.payload.log_head.hash,
    });
  });
  it('treats an invalid closing-anchor signature as no closing anchor', async () => {
    const events = stage();
    const { built } = settlement(events, 'last');
    const bad = async (h: string) => {
      const tx = structuredClone(recorded.koios[h] ?? null);
      if (tx && h === closingTx()) {
        tx.metadata = { '1694': { ...(tx.metadata?.['1694'] as object), signature: '00'.repeat(64) } };
      }
      return tx;
    };
    expect(await readAnchor(events, bad, closingTx())).toEqual({
      seq: built.payload.log_head.seq,
      head: built.payload.log_head.hash,
    });
  });
  it('does not treat a decoy mandate-named token on another policy as the closing anchor', async () => {
    const events = stage();
    const { built } = settlement(events, 'last');
    const last = events[events.length - 1]!;
    const settlementHead = { seq: built.payload.log_head.seq, head: built.payload.log_head.hash };
    const closingHead = { seq: last.seq, head: last.hash };
    const otherPolicy = 'cc'.repeat(28);
    // Datum key stays the real engine key, so a name-only match would still verify this token.
    const decoyOnly = async (h: string): Promise<KoiosTx | null> => {
      const tx = structuredClone(recorded.koios[h] ?? null);
      if (tx && h === closingTx()) {
        tx.reference_inputs = tx.reference_inputs.map((u) => ({
          ...u,
          asset_list: u.asset_list.map((a) => ({ ...a, policy_id: otherPolicy })),
        }));
      }
      return tx;
    };
    expect(await readAnchor(events, decoyOnly, closingTx())).toEqual(settlementHead);
    // The decoy is listed first and carries a different key. The run's own mandate token is still there.
    const decoyFirst = async (h: string): Promise<KoiosTx | null> => {
      const tx = structuredClone(recorded.koios[h] ?? null);
      if (tx && h === closingTx()) {
        const real = tx.reference_inputs.find((u) => u.asset_list.some((a) => a.policy_id !== otherPolicy));
        if (!real) return tx;
        const decoy = structuredClone(real);
        decoy.asset_list = decoy.asset_list.map((a) => ({ ...a, policy_id: otherPolicy }));
        const datum = decoy.inline_datum?.value;
        if (datum && 'fields' in datum) {
          const key = datum.fields[3];
          if (key && 'bytes' in key) key.bytes = '11'.repeat(32);
        }
        tx.reference_inputs = [decoy, ...tx.reference_inputs];
      }
      return tx;
    };
    expect(await readAnchor(events, decoyFirst, closingTx())).toEqual(closingHead);
  });
  it('does not treat a first-listed mandate token on another policy as the closing anchor when the log names no policy', async () => {
    const runId = 'run-lab-prompt_injection';
    const events = recorded.logs[runId]!;
    expect(events.some((e) => e.type === 'AuthorizationIssued')).toBe(false);
    const otherPolicy = 'cc'.repeat(28);
    // Datum key stays the real engine key, so a name-only match would still verify this token.
    const decoyFirst = async (h: string): Promise<KoiosTx | null> => {
      const tx = structuredClone(recorded.koios[h] ?? null);
      if (tx && h === closingTx(runId)) {
        const real = tx.reference_inputs.find((u) => u.asset_list.some((a) => a.asset_name === MANDATE_TOKEN_HEX));
        if (!real) return tx;
        const decoy = structuredClone(real);
        decoy.asset_list = decoy.asset_list.map((a) => ({ ...a, policy_id: otherPolicy }));
        tx.reference_inputs = [decoy, ...tx.reference_inputs];
      }
      return tx;
    };
    expect(await readAnchor(events, decoyFirst, closingTx(runId))).toBeNull();
    expect(replayPlan(events, await readAnchor(events, decoyFirst, closingTx(runId)), false, runId)).toMatchObject({
      verdict: 'unanchored',
      banner: REPLAY_UNANCHORED,
    });
  });
  it('treats a bare hash as no anchor', async () => {
    const events = stage();
    const { tx, built } = settlement(events, 'last');
    expect(await readAnchor(events, withHead(tx, built.payload.log_head.hash))).toBeNull();
    const fallback = await readAnchor(events, withHead(closingTx(), events[events.length - 1]!.hash), closingTx());
    expect(fallback).toEqual({ seq: built.payload.log_head.seq, head: built.payload.log_head.hash });
  });
  it('ignores a settlement head that claims an event at or after its own submission', async () => {
    const events = stage();
    const { tx, submitted, confirmed } = settlement(events, 'last');
    expect(await readAnchor(events, withHead(tx, { seq: submitted.seq, hash: submitted.hash }))).toBeNull();
    expect(await readAnchor(events, withHead(tx, { seq: confirmed.seq, hash: confirmed.hash }))).toBeNull();
  });
  it('falls back to the latest settlement when the closing anchor cannot be read', async () => {
    const events = stage();
    const { built } = settlement(events, 'last');
    const expected = { seq: built.payload.log_head.seq, head: built.payload.log_head.hash };
    const down = (h: string) => (h === closingTx() ? Promise.reject(new Error('relay down')) : koios(h));
    expect(await readAnchor(events, down, closingTx())).toEqual(expected);
    expect(await readAnchor(events, (h) => (h === closingTx() ? Promise.resolve(null) : koios(h)), closingTx())).toEqual(expected);
  });
  it('reads no anchor when the run never settled, the chain does not answer, or the metadata has no head', async () => {
    const unsettled = stage().filter((e) => e.type !== 'TransactionConfirmed');
    expect(await readAnchor(unsettled, koios)).toBeNull();
    expect(await readAnchor(stage(), async () => null, closingTx())).toBeNull();
    expect(await readAnchor(stage(), () => Promise.reject(new Error('relay down')), closingTx())).toBeNull();
    const { tx } = settlement(stage(), 'last');
    for (const head of [undefined, null, 42, 'ab', { seq: '30', hash: 'ab' }, { seq: 30 }, { seq: 1.5, hash: 'ab' }]) {
      expect(await readAnchor(stage(), withHead(tx, head))).toBeNull();
    }
  });
  it('fails the replay when the on-chain head disagrees with the stored log', async () => {
    const events = stage();
    const { tx, built } = settlement(events, 'last');
    const anchor = await readAnchor(events, withHead(tx, { seq: built.payload.log_head.seq, hash: 'ff'.repeat(32) }));
    expect(replayPlan(events, anchor).banner).toBe(REPLAY_FAILED);
  });
  it('gives a server that truncates the log after a settlement no full banner', async () => {
    const events = stage();
    const cut = events.slice(0, indexOf(events, 'ReceiptProven') + 1);
    // Closing pointer kept: the anchored head is not in the shortened log.
    expect(replayPlan(cut, await readAnchor(cut, koios, closingTx()), true, STAGE).verdict).toBe('failed');
    // Closing pointer dropped: only the settlement's pre-submit head is anchored.
    const { built } = settlement(cut, 'first');
    expect(replayPlan(cut, await readAnchor(cut, koios), true, STAGE)).toMatchObject({
      verdict: 'through',
      banner: replayVerifiedThrough(built.payload.log_head.seq),
    });
    // Cut exactly at that head: anchored to the last event, but the run had not ended.
    const atHead = events.filter((e) => e.seq <= built.payload.log_head.seq);
    const plan = replayPlan(atHead, await readAnchor(cut, koios), true, STAGE);
    expect(plan.verdict).toBe('through');
    expect(plan.banner).not.toBe(REPLAY_VERIFIED);
  });
  it('keeps a recorded run without a closing anchor, verified only through its settlement', async () => {
    const lab = recorded.logs['run-lab-replay']!;
    expect(recorded.anchors['run-lab-replay']).toBeUndefined();
    const { built } = settlement(lab, 'last');
    const plan = replayPlan(lab, await readAnchor(lab, koios), false, 'run-lab-replay');
    expect(plan).toMatchObject({ verdict: 'through', banner: replayVerifiedThrough(built.payload.log_head.seq) });
    // Runs that never issued an authorization name no mandate policy, so their closing anchor cannot be bound.
    const noMandatePolicy = new Set(['run-lab-prompt_injection', 'run-lab-prompt_injection_direct', 'run-lab-escalation_spam', 'run-lab-no_bond']);
    for (const r of recorded.runs.filter((x) => x.run_id !== 'run-lab-replay')) {
      const log = recorded.logs[r.run_id]!;
      const closed = replayPlan(log, await readAnchor(log, koios, closingTx(r.run_id)), r.run_id === STAGE, r.run_id);
      expect(closed.verdict, r.run_id).toBe(noMandatePolicy.has(r.run_id) ? 'unanchored' : 'verified');
    }
  });
  it('lists the actions whose evidence runs past the anchor', () => {
    const events = stage();
    const { built } = settlement(events, 'last');
    const through = built.payload.log_head.seq;
    expect([...unanchoredActions(events, through)]).toEqual(['A-0002', 'A-0003', 'A-0004', 'A-0005', 'A-0006', 'A-0007']);
    expect([...unanchoredActions(events, events[events.length - 1]!.seq)]).toEqual([]);
    expect([...unanchoredActions(events, null)]).toEqual([]);
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