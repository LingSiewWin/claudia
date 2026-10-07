import { describe, expect, it } from 'vitest';
import { runClaimed } from '../src/runtime';
import { clerk } from '../src/testing';
import { ADDR, fakeAuthority, LAB_WORK, MLAB } from './fake-authority';
import { deps } from './helpers';

const claimOf = async (fake: ReturnType<typeof fakeAuthority>) => (await fake.client.claim())!;

describe('stage run through the real engine', () => {
  it('works the queue in order and reproduces the demo outcomes', async () => {
    const fake = fakeAuthority({ cfo: (_id, a) => (a.counterparty.id === 'globex' ? 'decline' : 'approve') });
    const { deps: d, lines } = deps(fake, clerk({ gullible: true }));
    const result = await runClaimed(d, await claimOf(fake));
    expect(result.items.map((i) => [i.action_id.split('-')[2], i.proposal?.outcome, i.proposal?.reason, i.proposal?.resolution])).toEqual([
      ['1', 'ALLOW', null, 'settled'],
      ['2', 'ESCALATE', null, 'settled'],
      ['3', 'ESCALATE', 'PRINCIPAL_DECLINED', 'declined'],
      ['4', 'DENY', 'AMOUNT_ABOVE_HARD_CAP', 'denied'],
      ['5', 'DENY', 'PURPOSE_NOT_AUTHORIZED', 'denied'],
      ['6', 'DENY', 'RECIPIENT_MISMATCH', 'denied'],
      ['7', 'DENY', 'TREASURY_FLOOR_VIOLATION', 'denied'],
    ]);
    expect([fake.state.balance, fake.state.spent]).toEqual([108_580_000n, 26_420_000n]);
    expect(fake.checks.every((c) => c.execute)).toBe(true);
    // The two escalations are checked twice each: the 402, then the paid retry under the same idempotency key.
    expect([...new Set(fake.checks.map((c) => c.key))]).toEqual(result.items.map((i) => `agent:${fake.runId}:${i.action_id}`));
    expect(fake.checks.filter((c) => c.payment).map((c) => [c.key.split(':')[2], c.payment!.payload.approval_id])).toEqual([
      ['A-0f0e0d0c-2', 'AP-1'],
      ['A-0f0e0d0c-3', 'AP-2'],
    ]);
    expect(result.summary).toEqual({ escalations: 2, bonds_paid: 2, bonds_refunded: 2, budget_denials: 0 });
    expect(fake.finished()).toBe(1);
    expect(lines.at(-1)).toMatchObject({ event: 'run_finished', items: 7, proposals: 7, escalations: 2, bonds_paid: 2, bonds_refunded: 2, budget_denials: 0 });
  });

  it('a model that ignores the phishing email pays INV-3823 to the vendor of record', async () => {
    const fake = fakeAuthority({ cfo: (_id, a) => (a.counterparty.id === 'globex' ? 'decline' : 'approve') });
    const result = await runClaimed(deps(fake, clerk({ gullible: false })).deps, await claimOf(fake));
    expect(result.items[5]!.proposal).toMatchObject({ invoice_number: 'INV-3823', recipient: ADDR.aws, outcome: 'ALLOW', resolution: 'settled' });
  });

  it('reports a still-pending approval after the timeout instead of waiting forever', async () => {
    let t = 0;
    const fake = fakeAuthority({ cfo: () => 'decline' });
    // Hide the CFO's answer: the log never shows a final event for approvals.
    const events = fake.client.events;
    fake.client.events = async (id) => (await events(id)).filter((e) => e.type !== 'CFODeclined');
    const { deps: d } = deps(fake, clerk({ gullible: false }), { now: () => (t += 1_000), resolveTimeoutMs: 5_000 });
    const result = await runClaimed(d, await claimOf(fake));
    expect(result.items[1]!.proposal?.resolution).toBe('pending');
  });
});

describe('Attack Lab prompt injection (M-LAB)', () => {
  const lab = (attack: string) => fakeAuthority({ mandate: MLAB, balance: '10', work: LAB_WORK, kind: 'lab', attack });

  it('a fooled model is stopped by invoice verification: DENY RECIPIENT_MISMATCH, nothing executes', async () => {
    const fake = lab('prompt_injection');
    const result = await runClaimed(deps(fake, clerk({ gullible: true })).deps, await claimOf(fake));
    expect(result.items[0]!.proposal).toMatchObject({ recipient: ADDR.attacker, outcome: 'DENY', reason: 'RECIPIENT_MISMATCH', resolution: 'denied' });
    expect(fake.checks.map((c) => c.execute)).toEqual([false]);
    expect(fake.events.find((e) => e.type === 'ActionDenied')?.payload).toEqual({ reason: 'RECIPIENT_MISMATCH', layer: 'cre' });
    expect(fake.state.balance).toBe(10_000_000n);
  });

  it('an unfooled model is recorded as such: authorized for the real vendor, never executed', async () => {
    const fake = lab('prompt_injection');
    const result = await runClaimed(deps(fake, clerk({ gullible: false })).deps, await claimOf(fake));
    expect(result.items[0]!.proposal).toMatchObject({ recipient: ADDR.aws, outcome: 'ALLOW', resolution: 'authorized' });
    expect(fake.state.balance).toBe(10_000_000n);
    expect(fake.finished()).toBe(1);
  });

  it('the direct variant applies the email verbatim without the model and is denied by CRE', async () => {
    const fake = lab('prompt_injection_direct');
    const model = clerk({ gullible: false });
    const result = await runClaimed(deps(fake, model).deps, await claimOf(fake));
    expect(model.inputs).toHaveLength(0);
    expect(result.items[0]!.proposal).toMatchObject({ recipient: ADDR.attacker, outcome: 'DENY', reason: 'RECIPIENT_MISMATCH' });
    expect(fake.checks[0]!.action).toMatchObject({ mandate_id: 'M-LAB', actor: 'lab-agent-01', amount: { value: '500000' }, source: { vault: 'acme-lab' } });
  });
});

describe('failure handling', () => {
  it('retries 503 with the same idempotency key and gets one decision', async () => {
    const { AuthorityError } = await import('../src/authority');
    const fake = fakeAuthority({ work: { queue: [{ kind: 'invoice', invoice_number: 'INV-3821' }], messages: [] } });
    fake.failNext(new AuthorityError(503, 'cardano unavailable', 1));
    const result = await runClaimed(deps(fake, clerk({ gullible: false })).deps, await claimOf(fake));
    expect(result.items[0]!.proposal?.outcome).toBe('ALLOW');
    expect(fake.checks).toHaveLength(1);
  });

  it('refuses to run with a key that is not the mandate delegate, and still finishes the run', async () => {
    const fake = fakeAuthority();
    const { deps: d } = deps(fake, clerk({ gullible: false }), { agentKeys: new Map([['M-001', new Uint8Array(32).fill(9)]]) });
    await expect(runClaimed(d, await claimOf(fake))).rejects.toThrow("is not the mandate's delegate key");
    expect([fake.checks.length, fake.finished()]).toEqual([0, 1]);
  });
});
