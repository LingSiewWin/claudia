import { describe, expect, it } from 'vitest';
import { briefHash, buildBrief, canonicalHash, evaluate, formatUnits } from '../src';
import { action, M001, NOW, propose, state, verified } from './fixtures';

const DAY = Math.floor(NOW / 86_400_000);
const escalating = () => action({ id: 'A-2', amount: 18 });
const run = (a = escalating(), s = state(135, 0)) => evaluate({ mandate: M001, proposal: propose(a), state: s, verification: verified(a), nowMs: NOW });

describe('interrupt budget', () => {
  it('ESCALATE while budget remains, with the count in the check detail', () => {
    const e = run(escalating(), state(135, 0, { escalations_today: 2, escalation_day_index: DAY }));
    expect(e.outcome).toBe('ESCALATE');
    expect(e.checks.at(-1)).toMatchObject({ id: 'interrupt_budget', result: 'pass', detail: { used: 2, per_day: 3, remaining: 0 } });
  });
  it('the 4th escalation of the day is a DENY, not a page', () => {
    const e = run(escalating(), state(135, 0, { escalations_today: 3, escalation_day_index: DAY }));
    expect(e).toMatchObject({ outcome: 'DENY', reason: 'INTERRUPT_BUDGET_EXHAUSTED' });
    expect(e.approvals_required.map((a) => a.reason)).toEqual(['ABOVE_AUTONOMOUS_LIMIT']);
  });
  it('yesterday\'s count does not carry over', () => {
    expect(run(escalating(), state(135, 0, { escalations_today: 3, escalation_day_index: DAY - 1 })).outcome).toBe('ESCALATE');
  });
  it('ALLOW and DENY never touch the budget check', () => {
    const allow = run(action({ id: 'A-1', amount: 8.42 }), state(135, 0, { escalations_today: 3, escalation_day_index: DAY }));
    expect(allow.outcome).toBe('ALLOW');
    expect(allow.checks.at(-1)).toMatchObject({ id: 'interrupt_budget', result: 'not_evaluated' });
  });
});

describe('decision brief', () => {
  const a = escalating();
  const v = verified(a);
  const e = run(a);
  const input = { action: a, evaluation: e, mandate: M001, verification: { ...v, sepolia_tx: `0x${'ab'.repeat(32)}` }, bond: { amount: '5000000', asset: 'USDM' }, expires_at_ms: NOW + 600_000 };

  it('is deterministic and names the exact action', () => {
    const b1 = buildBrief(input);
    const b2 = buildBrief(JSON.parse(JSON.stringify(input)));
    expect(briefHash(b1)).toBe(briefHash(b2));
    expect(b1.action_hash).toBe(canonicalHash(a));
    expect(b1.what.amount.display).toBe('18 USDM');
    expect(b1.escalation).toEqual({ approver: 'CFO', because: [{ constraint: 'autonomous', reason: 'ABOVE_AUTONOMOUS_LIMIT' }] });
    expect(b1.will_happen).toContain(a.recipient.address);
    expect(b1.cost).toEqual({ bond: { amount: '5000000', asset: 'USDM' }, interrupt_budget: { used: 0, per_day: 3 } });
    expect(b1.verified?.result).toBe('VERIFIED');
  });
  it('refuses an evaluation of another action', () => {
    expect(() => buildBrief({ ...input, action: action({ id: 'A-9', amount: 18 }) })).toThrow(/another action/);
  });
  it('formats base units without floats', () => {
    expect(formatUnits('8420000', 6)).toBe('8.42');
    expect(formatUnits('5', 6)).toBe('0.000005');
    expect(formatUnits('18000000', 6)).toBe('18');
    expect(formatUnits('7', 0)).toBe('7');
  });
});
