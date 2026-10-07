import { readFileSync } from 'node:fs';
import { bytesToHex, fieldsFromRecord, publicKeyFromSecret, verifyAuthorizationRecord } from '@authority/core';
import { afterEach, describe, expect, it } from 'vitest';
import { forgeAuthorization, labKeys } from '../src/lab';
import type { LabRunner } from '../src/ports';
import { ADDR, action, AGENT_KEY, type Api, inv, LAB_AGENT_SK, LAB_ENGINE_SK, signed, startApi } from './harness';

let api: Api;
afterEach(() => api?.close());
const wait = async (runId: string, type: string) => {
  for (let i = 0; i < 500; i++) {
    const events = await api.log(runId);
    if (events.some((e) => e.type === type)) return events;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${type}`);
};

describe('Attack Lab isolation', () => {
  it('the lab module reads only M_LAB_* settings and never names the stage keys', () => {
    const touched: string[] = [];
    const env = new Proxy({} as Record<string, string>, {
      get: (_t, name: string) => {
        touched.push(name);
        return '11'.repeat(32);
      },
    });
    labKeys(env);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((n) => n.startsWith('M_LAB_'))).toBe(true);
    const source = readFileSync(new URL('../src/lab.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/M001|process\.env/);
  });

  it('a forged (stolen key) authorization is a valid M-LAB signature, flagged compromised in the log', () => {
    const real = forgeAuthorization(
      {
        chainTag: 0,
        vaultHash: 'a2'.repeat(28),
        mandateRef: 'b2'.repeat(28),
        mandateHash: 'cc'.repeat(32),
        mandateVersion: 1,
        actionHash: 'dd'.repeat(32),
        actionType: 1,
        assetPolicy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde',
        assetName: '0014df10745553444d',
        amount: 1_800_000n,
        recipient: ADDR.aws,
        nonce: 9n,
        validUntil: 1_800_000_000_000n,
        requiresPrincipal: false,
        verificationRef: null,
      },
      LAB_ENGINE_SK,
    );
    expect(verifyAuthorizationRecord(real, bytesToHex(publicKeyFromSecret(LAB_ENGINE_SK)))).toBe(true);
    expect(fieldsFromRecord(real).amount).toBe(1_800_000n);
  });
});

describe('Attack Lab runs', () => {
  it('vault attack: real authorization from the M-LAB engine, forged one flagged, AttackResult closes the run', async () => {
    const runner: LabRunner = {
      async run(attack, ctx) {
        const valid = await ctx.authorize('INV-L-0001');
        const forged = await ctx.forge({ ...fieldsFromRecord(valid), amount: 1_800_000n, nonce: 99n });
        await ctx.record('TransactionBuilt', null, { tx_hash: 'ee'.repeat(32), tx_body_cbor: '84a4' });
        await ctx.record('TransactionRejected', null, { tx_hash: 'ee'.repeat(32), invariant: 'R11', error: 'r11 ? False', tx_body_cbor: '84a4' });
        expect(attack).toBe('cfo_bypass');
        expect(forged.fields.requires_principal).toBe(false);
        return { code: 'R11', tx_hash: 'ee'.repeat(32), funds_moved: '0' };
      },
    };
    api = await startApi({ labRunner: runner });
    const { run_id } = (await api.post('/v1/lab/attacks', { attack: 'cfo_bypass' })).json;
    const events = await wait(run_id, 'AttackResult');
    const issued = events.filter((e) => e.type === 'AuthorizationIssued');
    expect(issued.map((e) => e.payload.compromised_engine)).toEqual([false, true]);
    expect(issued[0]!.payload.authorization.engine_public_key).toBe(bytesToHex(publicKeyFromSecret(LAB_ENGINE_SK)));
    expect(events[0]!.payload.mandate_id).toBe('M-LAB');
    expect(events.at(-1)!.payload).toEqual({ attack: 'cfo_bypass', stopped_by: 'vault', code: 'R11', funds_moved: '0', tx_hash: 'ee'.repeat(32) });
    expect((await api.post('/v1/lab/attacks', { attack: 'replay' })).status).toBe(200); // the previous run finished
  });

  it('a not-primed daily cap is not recorded as a submitted attack', async () => {
    const runner: LabRunner = {
      async run() {
        return { code: 'NOT_PRIMED', tx_hash: null, funds_moved: '0', outcome: 'not_primed' };
      },
    };
    api = await startApi({ labRunner: runner });
    const { run_id } = (await api.post('/v1/lab/attacks', { attack: 'daily_cap' })).json;
    const events = await wait(run_id, 'AttackNotPrimed');
    expect(events.some((e) => e.type === 'AttackResult')).toBe(false);
    expect(events.some((e) => e.type === 'TransactionRejected')).toBe(false);
    expect(events.filter((e) => e.type === 'AttackNotPrimed').map((e) => e.payload)).toEqual([{ attack: 'daily_cap', code: 'NOT_PRIMED' }]);
  });

  it('vault attacks need the lab runner; unknown attacks are 400', async () => {
    api = await startApi();
    expect((await api.post('/v1/lab/attacks', { attack: 'replay' })).status).toBe(501);
    expect((await api.post('/v1/lab/attacks', { attack: 'drain_everything' })).status).toBe(400);
  });

  it('prompt injection runs through the real agent: CRE stops the fooled agent, or the agent is recorded as not fooled', async () => {
    api = await startApi();
    const auth = { authorization: `Bearer ${AGENT_KEY}` };
    const { run_id } = (await api.post('/v1/lab/attacks', { attack: 'prompt_injection' })).json;
    const claimed = (await api.post('/v1/agent/runs/claim', {}, auth)).json;
    expect(claimed).toMatchObject({ run_id, kind: 'lab', mandate_id: 'M-LAB', attack: 'prompt_injection' });
    const fooled = action({ id: 'LAB-PI-1', invoice: inv('INV-L-0001'), recipient: ADDR.attacker, mandateId: 'M-LAB' });
    const res = await api.check({ mandate_id: 'M-LAB', proposal: signed({ ...fooled, source: { vault: 'acme-lab' } }, LAB_AGENT_SK), execute: true, run_id });
    expect(res.json.evaluation).toMatchObject({ outcome: 'DENY', reason: 'RECIPIENT_MISMATCH' });
    await api.post(`/v1/agent/runs/${run_id}/finish`, {}, auth);
    expect((await api.log(run_id)).filter((e) => e.type === 'AttackResult').map((e) => e.payload)).toEqual([
      { attack: 'prompt_injection', stopped_by: 'cre', code: 'RECIPIENT_MISMATCH', funds_moved: '0', tx_hash: null },
    ]);

    const second = (await api.post('/v1/lab/attacks', { attack: 'prompt_injection_direct' })).json.run_id;
    await api.post('/v1/agent/runs/claim', {}, auth);
    await api.post(`/v1/agent/runs/${second}/finish`, {}, auth);
    expect((await api.log(second)).at(-1)!.payload).toMatchObject({ stopped_by: 'agent', code: 'AGENT_REJECTED_PHISHING', funds_moved: '0' });
  });
});
