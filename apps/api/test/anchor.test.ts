import { bytesToHex, publicKeyFromSecret, verifyEvidenceAnchor } from '@authority/core';
import { verifyChain } from '@authority/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { action, AGENT_KEY, type Api, ENGINE_SK, inv, MASUMI_KEY, signed, startApi } from './harness';

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

  it('a finished run returns a closing head the mandate engine key signed', async () => {
    const denied = await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-4', invoice: inv('INV-3825') })), execute: false }, { key: MASUMI_KEY });
    const { events, closing } = (await api.get(`/v1/runs/${denied.json.run_id}/log`)).json;
    const last = events.at(-1);
    expect(closing).toEqual({ seq: last.seq, hash: last.hash, signature: expect.any(String) });
    expect(
      verifyEvidenceAnchor(denied.json.run_id, closing.seq, closing.hash, closing.signature, bytesToHex(publicKeyFromSecret(ENGINE_SK))),
    ).toBe(true);
  });

  it('an unfinished run has no closing head', async () => {
    const run = await api.agentRun();
    expect((await api.get(`/v1/runs/${run}/log`)).json.closing).toBeNull();
  });

  it('a finished stage run signs its last event with the engine key', async () => {
    const run = await api.agentRun();
    await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') })), execute: true, run_id: run });
    await api.executor.idle();
    await api.post(`/v1/agent/runs/${run}/finish`, {}, { authorization: `Bearer ${AGENT_KEY}` });
    const { events, closing } = (await api.get(`/v1/runs/${run}/log`)).json;
    const last = events.at(-1);
    expect(last.type).toBe('RunCompleted');
    expect(closing).toEqual({ seq: last.seq, hash: last.hash, signature: expect.any(String) });
    expect(verifyEvidenceAnchor(run, closing.seq, closing.hash, closing.signature, bytesToHex(publicKeyFromSecret(ENGINE_SK)))).toBe(true);
  });
});
