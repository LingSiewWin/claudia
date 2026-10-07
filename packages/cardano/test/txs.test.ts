import { type UTxO, core, pubKeyAddress, scriptAddress, serializeAddressObj } from '@meshsdk/core';
import { describe, expect, it } from 'vitest';
import { type TxPlan, buildTx } from '../src/build';
import { type Evaluation, evaluateTx, slotAt } from '../src/chain';
import { authorizationData, digestDatum, vaultDatumData } from '../src/data';
import { PREPROD_USDM, PUBLIC_TEST_ENGINE_VKEY, anchorDatumFor, keysOf, mandateAt, scriptsOf } from '../src/deployment';
import { labRecord, labRelease } from '../src/lab';
import { engineState, readVault } from '../src/state';
import {
  DAY_MS,
  RECIPIENT_OUT,
  checkRelease,
  planAnchorMint,
  planAnchorRevoke,
  planAnchorUpdate,
  planDeposit,
  planRefScript,
  planRelease,
  planVaultMint,
  planVaultReset,
} from '../src/txs';
import { APPROVER_PKH, NOW, PRINCIPAL_PKH, USDM, type World, ada, datumCbor, freshHash, usdm, world } from './world';

const honest = async (w: World, plan: TxPlan): Promise<Evaluation> => evaluateTx(w.env, await buildTx(w.env, plan));
const DAY = BigInt(Math.floor((NOW - 60_000) / DAY_MS));

describe('honest transactions pass the real validators', () => {
  it('release within the autonomous limit', async () => {
    const w = world();
    const plan = planRelease(labRelease(w.lab(), labRecord(w.lab())));
    expect(plan.requiredSigners).toEqual([]);
    expect(plan.metadata).toMatchObject({ mandate: 'M-LAB@1' });
    const r = await honest(w, plan);
    expect(r.ok).toBe(true);
    if (r.ok) console.log('release exec units', JSON.stringify(r.budgets));
  });

  it('release above the autonomous limit, flagged, with the payment approver (not the admin key) as required signer', async () => {
    const w = world();
    const plan = planRelease(labRelease(w.lab(), labRecord(w.lab(), { amount: '1800000', requires_principal: true })));
    expect(plan.requiredSigners).toEqual([APPROVER_PKH]);
    expect((await honest(w, plan)).ok).toBe(true);
  });

  it('release on the same UTC day accumulates spent_today', async () => {
    const w = world();
    w.setVault({ last_nonce: 4n, day_index: DAY, spent_today: 4_100_000n }, 9_000_000n);
    const plan = planRelease(labRelease(w.lab(), labRecord(w.lab(), { amount: '900000' })));
    expect(plan.outputs[0]?.datum).toEqual(vaultDatumData({ last_nonce: 5n, day_index: DAY, spent_today: 5_000_000n }));
    expect((await honest(w, plan)).ok).toBe(true);
  });

  it('30 s after midnight the lower bound is the start of the vault day, not now - 60 s', async () => {
    const w = world();
    const midnight = Math.floor(NOW / DAY_MS) * DAY_MS;
    w.setVault({ last_nonce: 1n, day_index: BigInt(midnight / DAY_MS), spent_today: 500_000n }, 9_500_000n);
    const lab = w.lab({ nowMs: midnight + 30_000 });
    const plan = planRelease(labRelease(lab, labRecord(lab)));
    expect(plan.validity?.lowerSlot).toBe(slotAt(midnight));
    expect((await honest(w, plan)).ok).toBe(true);
  });

  it('deposit, demo reset (last_nonce kept), anchor update and revoke', async () => {
    const w = world();
    expect((await honest(w, planDeposit(w.deployment, w.anchor, w.vault, w.refScript, 2_000_000n, w.principal))).ok).toBe(true);
    w.setVault({ last_nonce: 7n, day_index: DAY, spent_today: 3_000_000n }, 7_000_000n);
    const reset = planVaultReset(w.deployment, w.anchor, w.vault, w.refScript, w.principal, 1_500_000n);
    expect(reset.outputs[0]?.datum).toEqual(vaultDatumData({ last_nonce: 7n, day_index: 0n, spent_today: 0n }));
    expect(reset.requiredSigners).toEqual([PRINCIPAL_PKH]);
    expect((await honest(w, reset)).ok).toBe(true);
    const v2 = anchorDatumFor(mandateAt(w.deployment, 2), PREPROD_USDM);
    expect(v2.approver_pkh).toBe(APPROVER_PKH);
    const update = planAnchorUpdate(w.deployment, w.anchor, v2, w.principal);
    expect(update.requiredSigners).toEqual([PRINCIPAL_PKH]);
    expect((await honest(w, update)).ok).toBe(true);
    expect((await honest(w, planAnchorRevoke(w.deployment, w.anchor, w.principal))).ok).toBe(true);
  });

  it('anchor mint, vault mint and reference script', async () => {
    const w = world();
    const [anchorSeed, vaultSeed] = w.principal.utxos;
    const datum = anchorDatumFor(w.deployment.mandate, PREPROD_USDM);
    expect([datum.principal_pkh, datum.approver_pkh]).toEqual([PRINCIPAL_PKH, APPROVER_PKH]);
    expect(keysOf(w.deployment)).toEqual({ principal: PRINCIPAL_PKH, approver: APPROVER_PKH });
    const mint = planAnchorMint(anchorSeed as UTxO, datum, w.principal);
    expect(mint.script.hash).toBe(w.deployment.anchor.policy);
    expect(mint.plan.requiredSigners).toEqual([PRINCIPAL_PKH]);
    expect((await honest(w, mint.plan)).ok).toBe(true);
    const vault = planVaultMint(PREPROD_USDM, w.anchor, vaultSeed as UTxO, 10_000_000n, w.principal);
    expect(vault.script.hash).toBe(w.deployment.vault.hash);
    expect((await honest(w, vault.plan)).ok).toBe(true);
    expect(await buildTx(w.env, planRefScript(vault.script, w.executor))).toMatch(/^84/);
  });

  it('anchor mint spends the seed and does not use it as collateral', async () => {
    const w = world();
    const [seed] = w.principal.utxos;
    const spare = w.principal.utxos.find((u) => u.output.amount.length === 1 && u.output.amount[0]?.quantity === String(40_000_000));
    if (!seed || !spare) throw new Error('test world is missing the seed or the spare ADA UTxO');
    const datum = anchorDatumFor(w.deployment.mandate, PREPROD_USDM);
    // A copy of the 20 ADA seed: exclusion must match the outpoint, not this object.
    const seedCopy: UTxO = {
      input: { txHash: seed.input.txHash, outputIndex: seed.input.outputIndex },
      output: { ...seed.output, amount: seed.output.amount.map((a) => ({ ...a })) },
    };
    const body = core.deserializeTx(await buildTx(w.env, planAnchorMint(seedCopy, datum, w.principal).plan)).body();
    const point = (txHash: string, index: number) => `${txHash}#${index}`;
    const listed = (inputs: { values(): readonly { toCore(): { txId: string; index: number } }[] }) =>
      inputs.values().map((i) => {
        const c = i.toCore();
        return point(c.txId, c.index);
      });
    const seedPoint = point(seed.input.txHash, seed.input.outputIndex);
    const collateral = body.collateral();
    if (!collateral) throw new Error('anchor mint tx has no collateral');
    expect(listed(body.inputs())).toContain(seedPoint);
    expect(listed(collateral)).not.toContain(seedPoint);
    expect(listed(collateral)).toEqual([point(spare.input.txHash, spare.input.outputIndex)]);
  });
});

describe('the honest builders refuse before building', () => {
  it('a record edited after signing', () => {
    const w = world();
    const r = labRecord(w.lab());
    expect(() => checkRelease(labRelease(w.lab(), { ...r, fields: { ...r.fields, amount: '5000000' } }))).toThrow(/engine key/);
  });
  it('an expired record', () => {
    const w = world();
    expect(() => checkRelease(labRelease(w.lab(), labRecord(w.lab(), { valid_until: NOW - 60_000 })))).toThrow(/expired/);
  });
  it('a replayed nonce', () => {
    const w = world();
    w.setVault({ last_nonce: 1n, day_index: DAY, spent_today: 500_000n }, 9_500_000n);
    expect(() => checkRelease(labRelease(w.lab(), labRecord(w.lab(), { nonce: '1' })))).toThrow(/nonce/);
  });
  it('an unflagged release above the autonomous limit', () => {
    const w = world();
    expect(() => checkRelease(labRelease(w.lab(), labRecord(w.lab(), { amount: '1800000' })))).toThrow(/requires_principal/);
  });
  it('a script-address recipient (it could not spend an output with an inline datum)', () => {
    const w = world();
    const script = serializeAddressObj(scriptAddress('c0'.repeat(28)), 0);
    expect(() => checkRelease(labRelease(w.lab(), labRecord(w.lab(), { recipient: script })))).toThrow(/script address/);
  });
  it('an anchor naming the public test engine key, or one key as both admin and approver', () => {
    const w = world();
    const [seed] = w.principal.utxos;
    const datum = anchorDatumFor(w.deployment.mandate, PREPROD_USDM);
    expect(() => planAnchorMint(seed as UTxO, { ...datum, engine_vkey: PUBLIC_TEST_ENGINE_VKEY }, w.principal)).toThrow(/public test key/);
    expect(() => planAnchorUpdate(w.deployment, w.anchor, { ...datum, version: 2, approver_pkh: PRINCIPAL_PKH }, w.principal)).toThrow(/differ/);
  });
});

describe('wire shapes and state', () => {
  it('the authorization is the vault type: 18 fields, recipient split into tags and hashes', () => {
    const w = world();
    const d = authorizationData(labRecord(w.lab())) as { constructor: number; fields: unknown[] };
    expect(d.constructor).toBe(0);
    expect(d.fields).toHaveLength(18);
    // The world's AWS address is a base address: key payment (tag 0) and key stake (tag 1).
    expect(d.fields.slice(10, 14)).toEqual([{ int: 0 }, { bytes: 'a1'.repeat(28) }, { int: 1 }, { bytes: 'a2'.repeat(28) }]);
    expect(d.fields[17]).toEqual({ bytes: '00'.repeat(32) });
  });

  it('the recipient output carries the digest as inline datum and no reference script', () => {
    const w = world();
    const r = labRecord(w.lab());
    const out = planRelease(labRelease(w.lab(), r)).outputs[RECIPIENT_OUT];
    expect(out).toEqual({ address: r.fields.recipient, amount: [{ unit: USDM, quantity: '500000' }], datum: digestDatum(r) });
  });

  it('the engine sees the thread UTxO balance, not junk paid to the vault address', async () => {
    const w = world();
    w.add({ input: { txHash: freshHash(), outputIndex: 0 }, output: { address: w.deployment.vault.address, amount: [ada(2), usdm(7_000_000n)], plutusData: datumCbor({ int: 0 }) } });
    const vault = await readVault(w.fetcher, w.deployment);
    expect(engineState(w.anchor, vault, 1).vault_balance).toBe('10000000');
  });

  it('a deployment record that no longer matches plutus.json is refused', () => {
    const w = world();
    expect(() => scriptsOf(w.deployment)).not.toThrow();
    expect(() => scriptsOf({ ...w.deployment, vault: { ...w.deployment.vault, hash: 'ab'.repeat(28) } })).toThrow(/no longer matches/);
  });
});
