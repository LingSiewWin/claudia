import { MeshWallet, core, deserializeAddress, resolveTxHash } from '@meshsdk/core';
import { describe, expect, it } from 'vitest';
import { buildTx } from '../src/build';
import { labRecord, labRelease } from '../src/lab';
import { openLaceSession, planSummary } from '../src/lace';
import { planRelease } from '../src/txs';
import { addWitnessSet, mergeWitness, newMnemonic, vkeyHashes } from '../src/wallet';
import { world } from './world';

const meshWallet = async () => {
  const w = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: newMnemonic().split(' ') } });
  await w.init();
  return { w, pkh: deserializeAddress(await w.getChangeAddress()).pubKeyHash };
};

describe('co-signing (CIP-30 partial sign, then the executor)', () => {
  it('adds the approver witness without changing the tx body', async () => {
    const w = world();
    const unsigned = await buildTx(w.env, planRelease(labRelease(w.lab(), labRecord(w.lab(), { amount: '1800000', requires_principal: true }))));
    const approver = await meshWallet();
    const witnessSet = await approver.w.signTx(unsigned, true, false);
    const merged = addWitnessSet(unsigned, witnessSet);
    expect(resolveTxHash(merged)).toBe(resolveTxHash(unsigned));
    expect(vkeyHashes(merged)).toEqual([approver.pkh]);
    expect(mergeWitness(unsigned, witnessSet, approver.pkh)).toBe(merged);
  });

  it('refuses a witness set from another key', async () => {
    const w = world();
    const unsigned = await buildTx(w.env, planRelease(labRelease(w.lab(), labRecord(w.lab()))));
    const other = await meshWallet();
    const witnessSet = await other.w.signTx(unsigned, true, false);
    expect(() => mergeWitness(unsigned, witnessSet, '5e'.repeat(28))).toThrow(/does not sign as/);
  });
});

describe('local signing page', () => {
  it('serves the page only under its one-time path and hands connect and sign jobs to the page', async () => {
    const s = await openLaceSession();
    try {
      const page = await fetch(s.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('window.cardano && window.cardano.lace');
      expect((await fetch(s.url.replace(/\/[0-9a-f]{32}\/$/, '/x/'))).status).toBe(404);

      // The page's side, with a Mesh wallet standing in for Lace's CIP-30 API.
      const lace = await meshWallet();
      const page1 = async () => {
        let job: { id: number; kind: string; txHex?: string } = { id: 0, kind: 'wait' };
        while (job.kind === 'wait') job = await (await fetch(`${s.url}job`)).json();
        const value = job.kind === 'connect'
          ? { networkId: 0, changeAddress: core.Address.fromBech32(await lace.w.getChangeAddress()).toBytes() }
          : await lace.w.signTx(job.txHex as string, true, false);
        await fetch(`${s.url}result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, ok: true, value }) });
      };
      const [account] = await Promise.all([s.connect(), page1()]);
      expect(account.pkh).toBe(lace.pkh);

      const w = world();
      const plan = planRelease(labRelease(w.lab(), labRecord(w.lab())));
      const unsigned = await buildTx(w.env, plan);
      const req = { label: 'test', txHex: unsigned, txHash: resolveTxHash(unsigned), signer: lace.pkh, summary: planSummary(plan) };
      const [witnessSet] = await Promise.all([s.sign(req), page1()]);
      expect(vkeyHashes(mergeWitness(unsigned, witnessSet, lace.pkh))).toEqual([lace.pkh]);
    } finally {
      await s.close();
    }
  });

  it('reports a refusal from the wallet', async () => {
    const s = await openLaceSession();
    try {
      const page = async () => {
        let job: { id: number; kind: string } = { id: 0, kind: 'wait' };
        while (job.kind === 'wait') job = await (await fetch(`${s.url}job`)).json();
        await fetch(`${s.url}result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, ok: false, error: 'user declined', code: 2 }) });
      };
      await expect(Promise.all([s.connect(), page()])).rejects.toThrow(/Lace refused \(2\): user declined/);
    } finally {
      await s.close();
    }
  });
});
