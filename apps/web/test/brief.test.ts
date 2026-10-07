import { briefHash } from '@authority/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { declineMessage, type BondRef } from '../lib/contract';
import { BOND_TEXT, DECLINE_REASON_TEXT, bondAmount, bondStatus, budgetText, plainReason } from '../lib/format';
import { offlineChecks } from '../lib/verify';
import { bundle, recorded, stage } from './load';

const root = fileURLToPath(new URL('..', import.meta.url));
const bond: BondRef = { amount: '5000000', asset: 'ADA', escrow_address: 'addr_test1w', locked_until_ms: 1_000, tx_hash: null, output_index: null, status: 'required' };

describe('bond and budget labels', () => {
  it('formats the bond in its own asset, not dollars', () => {
    expect(bondAmount(bond)).toBe('5.00 ADA');
    expect(bondAmount({ amount: '12500000', asset: 'ADA' })).toBe('12.50 ADA');
  });
  it('derives expired only for a priced bond nobody locked in time', () => {
    expect(bondStatus(bond, 999)).toBe('required');
    expect(bondStatus(bond, 1_001)).toBe('expired');
    expect(bondStatus({ ...bond, status: 'locked', tx_hash: 'ab' }, 1_001)).toBe('locked');
    expect(bondStatus({ ...bond, status: 'refunded' }, 1_001)).toBe('refunded');
  });
  it('has a label for every bond status and decline reason', () => {
    expect(Object.keys(BOND_TEXT).sort()).toEqual(['captured', 'expired', 'locked', 'refunded', 'required']);
    expect(Object.keys(DECLINE_REASON_TEXT).sort()).toEqual(['frivolous', 'legitimate']);
    expect(budgetText(1, 3)).toBe('1 of 3 used today');
    expect(plainReason('INTERRUPT_BUDGET_EXHAUSTED')).toMatch(/interrupt budget/);
    expect(plainReason('BOND_REQUIRED')).toMatch(/nobody was paged/i);
  });
  it('signs the decline reason into the CIP-8 text', () => {
    expect(declineMessage('AP-1', 'frivolous')).toBe('{"approval_id":"AP-1","decision":"decline","reason":"frivolous"}');
  });
});

describe('Decision Brief in the fixtures', () => {
  it('reaches the human only after the bond: BondRequired, BondLocked, then ApprovalRequested with brief and bond', () => {
    const order = stage()
      .filter((e) => e.action_id === 'A-0002' && e.type.startsWith('Bond') || (e.action_id === 'A-0002' && e.type === 'ApprovalRequested'))
      .map((e) => e.type);
    expect(order).toEqual(['BondRequired', 'BondLocked', 'ApprovalRequested', 'BondRefunded']);
    for (const e of Object.values(recorded.logs).flat()) {
      if (e.type !== 'ApprovalRequested') continue;
      expect(e.payload.brief.schema).toBe('brief/v0.1');
      expect(e.payload.brief.action_id).toBe(e.action_id);
      expect(e.payload.brief.cost.bond).toEqual({ amount: '5000000', asset: 'ADA' });
      expect(e.payload.bond?.status).toBe('locked');
      expect(e.payload.brief.will_happen).toMatch(/^Release .* Nothing else is authorized by this signature\.$/);
    }
  });
  it('counts the interrupt budget up across a day in the brief itself', () => {
    const used = recorded.logs['run-lab-escalation_spam']!.flatMap((e) => (e.type === 'ApprovalRequested' ? [e.payload.brief.cost.interrupt_budget.used] : []));
    expect(used).toEqual([0, 1, 2]);
    expect(recorded.authority['M-LAB/CFO']).toMatchObject({ availability: 'budget_exhausted', interrupt_budget: { used: 3, per_day: 3 } });
    expect(recorded.authority['M-001/CFO']).toMatchObject({ availability: 'open', interrupt_budget: { used: 2, per_day: 3 }, price: { amount: '5000000', asset: 'ADA' } });
  });
  it('the pending inbox item carries the same brief the event stream carries', () => {
    const inbox = recorded.approvals[0]!;
    const requested = stage().find((e) => e.type === 'ApprovalRequested' && e.payload.approval_id === inbox.approval_id);
    expect(requested?.type).toBe('ApprovalRequested');
    if (requested?.type === 'ApprovalRequested') {
      expect(inbox.brief).toEqual(requested.payload.brief);
      expect(inbox.bond).toEqual(requested.payload.bond);
    }
  });
});

describe('receipt carries brief_hash and the bond outcome; Verify recomputes the hash', () => {
  it('R-0002 (CFO approved) has a brief whose hash matches; R-0001 (autonomous) has none', () => {
    const b2 = bundle('R-0002');
    expect(b2.brief?.schema).toBe('brief/v0.1');
    expect(b2.receipt.approval.brief_hash).toBe(briefHash(b2.brief!));
    expect(b2.receipt.approval.bond).toMatchObject({ status: 'refunded', amount: '5000000', asset: 'ADA' });
    expect(b2.receipt.approval.bond?.outcome_tx_hash).toMatch(/^[0-9a-f]{64}$/);
    const check = offlineChecks(b2).find((c) => c.id === 'brief_hash');
    expect(check).toMatchObject({ status: 'pass', detail: b2.receipt.approval.brief_hash });
    const b1 = bundle('R-0001');
    expect(b1.brief ?? null).toBeNull();
    expect(b1.receipt.approval.brief_hash).toBeUndefined();
    expect(offlineChecks(b1).some((c) => c.id === 'brief_hash')).toBe(false);
  });
  it('fails when the attached brief was edited', () => {
    const b = bundle('R-0002');
    b.brief!.why = 'Nothing to see here.';
    expect(offlineChecks(b).find((c) => c.id === 'brief_hash')?.status).toBe('fail');
    const other = bundle('R-0002');
    other.brief!.action_hash = 'ff'.repeat(32);
    other.receipt.approval.brief_hash = briefHash(other.brief!);
    expect(offlineChecks(other).find((c) => c.id === 'brief_hash')?.status).toBe('fail');
  });
});

describe('console wording', () => {
  const files = ['components/console-view.tsx', 'components/action-card.tsx', 'components/brief.tsx', 'lib/run.ts', 'lib/format.ts'].map((f) =>
    readFileSync(join(root, f), 'utf8'),
  );
  it('says ESCALATE, never "requires approval"', () => {
    for (const f of files) expect(f).not.toMatch(/requires approval/i);
  });
  it('offers both decline reasons and renders the brief sections in reading order', () => {
    const console = files[0]!;
    expect(console).toContain('Decline (reasonable ask, refund bond)');
    expect(console).toContain('Decline (frivolous, capture bond)');
    const brief = files[2]!;
    const names = [...brief.matchAll(/<Section name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['What', 'Why', 'What the engine checked', 'What was verified', 'Why a human', 'What exactly will happen', 'Cost', 'Expires']);
  });
});
