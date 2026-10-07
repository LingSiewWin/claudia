import { verifyChain } from '@authority/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { action, type Api, inv, MASUMI_KEY, signed, startApi } from './harness';

let api: Api;
beforeEach(async () => {
  api = await startApi();
});
afterEach(() => api.close());

describe('anchoring runs that end without their own settlement', () => {
  it('a denial-only run is "integrity checked, not anchored" until the next settlement commits a later head', async () => {
    const denied = await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-4', invoice: inv('INV-3825') })), execute: false }, { key: MASUMI_KEY });
    expect(denied.json.evaluation.reason).toBe('AMOUNT_ABOVE_HARD_CAP');
    expect((await api.get(`/v1/runs/${denied.json.run_id}/log`)).json.anchor).toBeNull();

    const run = await api.agentRun();
    await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') })), execute: true, run_id: run });
    await api.executor.idle();

    const { events, anchor } = (await api.get(`/v1/runs/${denied.json.run_id}/log`)).json;
    const settlement = api.cardano.built.at(-1)!;
    expect(anchor).toEqual({ tx_hash: settlement.txHash, ...settlement.metadata.log_head });
    expect(anchor.seq).toBeGreaterThanOrEqual(events.at(-1).seq);
    expect(await verifyChain(api.db, [{ seq: anchor.seq, hash: anchor.hash }])).toMatchObject({ ok: true });
  });
});
