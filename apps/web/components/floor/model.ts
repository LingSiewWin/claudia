import { actionTitle } from '../../lib/format';
import { type CardView, type RunView, decisionOf } from '../../lib/run';

/** Stations on the authority floor, left to right; sink sits in front of the escrow. */
export type Station = 'agent' | 'gate' | 'tower' | 'escrow' | 'desk' | 'vault' | 'ledger' | 'sink';
export type Tone = 'neutral' | 'permit' | 'cosign' | 'forbid';

export interface Crate {
  id: string;
  title: string;
  station: Station;
  tone: Tone;
  /** The crate came back to the agent: the gate, the tower, or the human sent it home. */
  bounced: boolean;
}

export interface Stations {
  gate: 'idle' | 'ALLOW' | 'ESCALATE' | 'DENY';
  tower: 'idle' | 'scanning';
  escrow: { locked: number; refunded: number; captured: number };
  /** The card whose brief is on the desk, waiting for the human. */
  desk: string | null;
  vault: 'idle' | 'releasing' | 'rejected';
  ledger: number;
}

export type Step = 'proposed' | 'evaluated' | 'verified' | 'bond' | 'human' | 'settled' | 'proven';
export const STEPS: readonly Step[] = ['proposed', 'evaluated', 'verified', 'bond', 'human', 'settled', 'proven'];
export type StepStatus = 'pending' | 'current' | 'done' | 'failed' | 'skipped';
export interface StepView {
  step: Step;
  status: StepStatus;
  at: string | null;
  note: string | null;
}

/** Timestamps the hook stamped when it first saw a step leave `pending`, per action and step. */
export type Stamps = Record<string, Partial<Record<Step, string>>>;

export interface Floor {
  crates: Crate[];
  stations: Stations;
  /** The crate the overlays describe: the caller's choice when it exists, else the busiest card. */
  selected: CardView | null;
  steps: StepView[];
}

export function stationOf(c: CardView): Station {
  switch (c.state) {
    case 'PROPOSED':
      return 'agent';
    case 'EVALUATING':
      return 'gate';
    case 'VERIFYING':
      return 'tower';
    case 'ESCALATED':
      return c.approval ? 'desk' : 'escrow';
    case 'AUTHORIZED':
    case 'EXECUTING':
    case 'SETTLED':
      return 'vault';
    case 'PROVEN':
      return 'ledger';
    case 'DENIED':
      if (c.denied?.layer === 'vault') return 'vault';
      return c.bond?.status === 'captured' ? 'sink' : 'agent';
  }
}

export function toneOf(c: CardView): Tone {
  if (c.state === 'DENIED') return 'forbid';
  if (c.state === 'SETTLED' || c.state === 'PROVEN') return 'permit';
  if (c.state === 'ESCALATED' || c.approval) return 'cosign';
  if (c.state === 'AUTHORIZED' || c.state === 'EXECUTING') return 'permit';
  return 'neutral';
}

export function crateOf(c: CardView): Crate {
  return {
    id: c.actionId,
    title: c.action ? actionTitle(c.action) : c.actionId,
    station: stationOf(c),
    tone: toneOf(c),
    bounced: c.state === 'DENIED' && c.denied?.layer !== 'vault' && c.bond?.status !== 'captured',
  };
}

export function stationsOf(view: RunView): Stations {
  const cards = view.cards;
  const latest = cards[cards.length - 1];
  const gate = latest && latest.state !== 'PROPOSED' ? (decisionOf(latest) ?? (latest.evaluation ? 'ALLOW' : 'idle')) : 'idle';
  const t = view.tally;
  return {
    gate,
    tower: cards.some((c) => c.verifying) ? 'scanning' : 'idle',
    escrow: { locked: cards.filter((c) => c.bond?.status === 'locked').length, refunded: t.bondRefunded, captured: t.bondCaptured },
    desk: cards.find((c) => c.approval?.status === 'pending')?.actionId ?? null,
    vault: cards.some((c) => c.denied?.layer === 'vault') && !cards.some((c) => c.state === 'EXECUTING' || c.state === 'SETTLED')
      ? 'rejected'
      : cards.some((c) => c.state === 'EXECUTING' || c.state === 'SETTLED')
        ? 'releasing'
        : 'idle',
    ledger: cards.filter((c) => c.state === 'PROVEN').length,
  };
}

const TERMINAL = new Set<CardView['state']>(['PROVEN', 'DENIED']);

/** The card people are watching: the caller's pick, else the last card still moving, else the last card. */
export function focusOf(view: RunView, wanted: string | null): CardView | null {
  const cards = view.cards;
  return cards.find((c) => c.actionId === wanted) ?? [...cards].reverse().find((c) => !TERMINAL.has(c.state)) ?? cards[cards.length - 1] ?? null;
}

/** Step statuses from the card alone; timestamps only where the card carries them. The hook fills the rest from stamps. */
export function stepsOf(c: CardView, stamps: Partial<Record<Step, string>> = {}): StepView[] {
  const denied = c.state === 'DENIED';
  const layer = c.denied?.layer ?? null;
  const past = (s: CardView['state'][]) => s.includes(c.state);
  const raw: Record<Step, Omit<StepView, 'step' | 'at'> & { at?: string | null }> = {
    proposed: { status: 'done', note: null, at: c.proposedAt },
    evaluated:
      c.state === 'EVALUATING'
        ? { status: 'current', note: null }
        : layer === 'engine'
          ? { status: 'failed', note: c.denied?.reason ?? null }
          : c.evaluation
            ? { status: 'done', note: decisionOf(c) ?? c.evaluation.outcome }
            : { status: 'pending', note: null },
    verified: c.verification
      ? c.verification.report.result === 'VERIFIED'
        ? { status: 'done', note: 'Chainlink CRE' }
        : { status: 'failed', note: c.verification.report.reason ?? 'MISMATCH' }
      : c.verifying
        ? { status: 'current', note: null }
        : denied || past(['AUTHORIZED', 'EXECUTING', 'SETTLED', 'PROVEN'])
          ? { status: 'skipped', note: null }
          : { status: 'pending', note: null },
    bond: c.bond
      ? c.bond.status === 'required'
        ? { status: denied ? 'failed' : 'current', note: 'bond required' }
        : { status: 'done', note: `bond ${c.bond.status}` }
      : denied || past(['AUTHORIZED', 'EXECUTING', 'SETTLED', 'PROVEN'])
        ? { status: 'skipped', note: null }
        : { status: 'pending', note: null },
    human: c.approval
      ? c.approval.status === 'pending'
        ? { status: 'current', note: null, at: c.approval.requestedAt }
        : c.approval.status === 'approved'
          ? { status: 'done', note: 'approved', at: c.approval.decidedAt }
          : { status: 'failed', note: `declined, ${c.approval.declineReason ?? 'no reason'}`, at: c.approval.decidedAt }
      : denied || past(['AUTHORIZED', 'EXECUTING', 'SETTLED', 'PROVEN'])
        ? { status: 'skipped', note: denied ? null : 'autonomous' }
        : { status: 'pending', note: null },
    settled: past(['SETTLED', 'PROVEN'])
      ? { status: 'done', note: null, at: c.tx.confirmedAt }
      : layer === 'vault'
        ? { status: 'failed', note: c.denied?.reason ?? null }
        : past(['AUTHORIZED', 'EXECUTING'])
          ? { status: 'current', note: null }
          : denied
            ? { status: 'skipped', note: null }
            : { status: 'pending', note: null },
    proven: c.state === 'PROVEN' ? { status: 'done', note: c.receipt?.id ?? null } : denied ? { status: 'skipped', note: null } : { status: 'pending', note: null },
  };
  return STEPS.map((step) => {
    const r = raw[step];
    return { step, status: r.status, note: r.note, at: r.at ?? stamps[step] ?? null };
  });
}

/** Stamp each step the first time it leaves `pending`, with the time of the event that moved it. Returns the same object when nothing changed. */
export function stamp(stamps: Stamps, view: RunView): Stamps {
  if (!view.lastAt) return stamps;
  let next = stamps;
  for (const c of view.cards) {
    for (const s of stepsOf(c)) {
      if (s.status === 'pending' || s.status === 'skipped' || next[c.actionId]?.[s.step]) continue;
      if (next === stamps) next = { ...stamps };
      next[c.actionId] = { ...next[c.actionId], [s.step]: view.lastAt };
    }
  }
  return next;
}

export function floorOf(view: RunView, selectedId: string | null, stamps: Stamps = {}): Floor {
  const selected = focusOf(view, selectedId);
  return {
    crates: view.cards.map(crateOf),
    stations: stationsOf(view),
    selected,
    steps: selected ? stepsOf(selected, stamps[selected.actionId]) : [],
  };
}
