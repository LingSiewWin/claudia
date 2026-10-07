import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { action, type Api, inv, MASUMI_KEY, signed, startApi, usdm } from './harness';

let api: Api;
beforeEach(async () => {
  api = await startApi();
});
afterEach(() => api.close());
const WITNESS = `a10081825820${'cd'.repeat(32)}5840${'ef'.repeat(64)}`;
const limits = { autonomous_limit: usdm('20'), hard_cap: usdm('50'), daily_cap: usdm('50'), treasury_minimum: usdm('100') };

describe('CFO mandate changes', () => {
  it('update: prepared unsigned, lands only with the CFO witness, then the engine evaluates under the new version', async () => {
    const prepared = await api.post('/v1/mandates/M-001/update', { limits });
    expect(prepared.json).toMatchObject({ version: 4, unsigned_tx_cbor: expect.stringMatching(/^84a4/) });
    expect((await api.post('/v1/mandates/M-001/submit', { tx_hash: prepared.json.tx_hash, cfo_witness_cbor: WITNESS })).status).toBe(200);
    const view = (await api.get('/v1/mandates/M-001')).json;
    expect(view.mandate.version).toBe(4);
    expect(view.limits.autonomous_limit).toBe(usdm('20'));
    const res = await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-2', invoice: inv('INV-3822') })), execute: false }, { key: MASUMI_KEY });
    expect(res.json.evaluation).toMatchObject({ outcome: 'ALLOW', mandate_version: 4 });
    const runs = (await api.get('/v1/runs?kind=stage')).json.runs;
    expect((await api.log(runs[0].run_id)).at(-1)).toMatchObject({ type: 'MandateUpdated', payload: { mandate_id: 'M-001', version: 4 } });
  });

  it('limits that break the mandate rules are refused (hard cap below the autonomous limit)', async () => {
    const res = await api.post('/v1/mandates/M-001/update', { limits: { ...limits, hard_cap: usdm('5') } });
    expect(res.status).toBe(422);
  });

  it('revoke: afterwards every check is MANDATE_REVOKED; an unknown prepared tx is 404', async () => {
    const prepared = await api.post('/v1/mandates/M-001/revoke', {});
    expect(prepared.json.version).toBe(4);
    await api.post('/v1/mandates/M-001/submit', { tx_hash: prepared.json.tx_hash, cfo_witness_cbor: WITNESS });
    const res = await api.check({ mandate_id: 'M-001', proposal: signed(action({ id: 'A-1', invoice: inv('INV-3821') })), execute: false }, { key: MASUMI_KEY });
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'MANDATE_REVOKED' });
    expect((await api.post('/v1/mandates/M-001/revoke', {})).status).toBe(409);
    expect((await api.post('/v1/mandates/M-001/submit', { tx_hash: 'ab'.repeat(32), cfo_witness_cbor: WITNESS })).status).toBe(404);
  });
});
