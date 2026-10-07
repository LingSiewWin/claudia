import { readFileSync } from 'node:fs';
import { sha256Hex } from '@authority/core';
import { type UTxO, pubKeyAddress, serializeAddressObj } from '@meshsdk/core';
import { describe, expect, it } from 'vitest';
import {
  type BondDatum,
  type BondUtxo,
  agentKeys,
  approvalRef,
  bondDatumFor,
  bondLockOutput,
  bondSpendPlan,
  escrowAddress,
  matchBonds,
  sinkAddress,
} from '../src/bond';
import { FIXED_BUDGET, buildTx } from '../src/build';
import { evaluateTx } from '../src/chain';
import { bondDatumData, parseBondDatum } from '../src/data';
import { APPROVER_PKH, NOW, ada, datumCbor, freshHash, world } from './world';

const REFERENCE = readFileSync(new URL('../../../contracts/cardano/scripts/blueprint.mjs', import.meta.url), 'utf8');
const pinned = (key: string) => new RegExp(`${key}: '([0-9a-z_]+)'`).exec(REFERENCE)?.[1];

const AGENT_PKH = 'ad'.repeat(28);
const AGENT_STAKE = 'ae'.repeat(28);
const AGENT = serializeAddressObj(pubKeyAddress(AGENT_PKH, AGENT_STAKE), 0);
const ACTION = '02'.repeat(32);

const price = {
  schema: 'escalation-price/v0.1' as const,
  approval_id: 'AP-0001',
  network: 'cardano-preprod' as const,
  asset: { policy_id: '', asset_name: '', symbol: 'ADA' as const },
  amount: '5000000',
  escrow_address: escrowAddress(0),
  action_hash: ACTION,
  approver_key_hash: APPROVER_PKH,
  locked_until_ms: NOW + 3_600_000,
  interrupt_budget: { used: 0, per_day: 3 },
};

const datum = (): BondDatum => bondDatumFor(price, agentKeys(AGENT));

const escrowUtxo = (d: BondDatum, lovelace = 5): UTxO => ({
  input: { txHash: freshHash(), outputIndex: 0 },
  output: { address: escrowAddress(0), amount: [ada(lovelace)], plutusData: datumCbor(bondDatumData(d)) },
});

const asBond = (u: UTxO, d: BondDatum): BondUtxo => ({ tx_hash: u.input.txHash, output_index: u.input.outputIndex, datum: d, amount: 5_000_000n, escrow_address: escrowAddress(0) });

describe('bond datum and addresses', () => {
  it('derives the escrow and sink addresses the aiken CLI pins', () => {
    expect(sinkAddress(0)).toBe(pinned('sinkAddress'));
    expect(escrowAddress(0)).toBe(pinned('escrowAddress'));
    expect(escrowAddress(1).startsWith('addr1')).toBe(true);
    expect(escrowAddress(1)).not.toBe(escrowAddress(0));
  });

  it('approval_ref is sha256 of the utf8 approval id', () => {
    expect(approvalRef('AP-0001')).toBe(sha256Hex('AP-0001'));
    expect(approvalRef('AP-0001')).toHaveLength(64);
  });

  it('round-trips the datum with and without a stake key', () => {
    const d = datum();
    expect(d).toMatchObject({ approval_ref: approvalRef('AP-0001'), action_hash: ACTION, agent_pkh: AGENT_PKH, agent_stake: AGENT_STAKE, approver_pkh: APPROVER_PKH, amount: 5_000_000n, locked_until_ms: price.locked_until_ms });
    expect(parseBondDatum(datumCbor(bondDatumData(d)))).toEqual(d);
    const unstaked = { ...d, agent_stake: null };
    expect(parseBondDatum(datumCbor(bondDatumData(unstaked)))).toEqual(unstaked);
  });

  it('refuses a script agent address and a foreign escrow address', () => {
    expect(() => agentKeys(sinkAddress(0))).toThrow('key address');
    expect(() => bondLockOutput({ ...price, escrow_address: sinkAddress(0) }, agentKeys(AGENT))).toThrow('escrow script');
    expect(bondLockOutput(price, agentKeys(AGENT)).output.amount).toEqual([{ unit: 'lovelace', quantity: '5000000' }]);
  });

  it('matchBonds keeps only the UTxO whose datum and value satisfy the price', () => {
    const d = datum();
    const good = escrowUtxo(d);
    const otherApproval = escrowUtxo({ ...d, approval_ref: approvalRef('AP-0002') });
    const underfunded = escrowUtxo(d, 4);
    const smallDatum = escrowUtxo({ ...d, amount: 4_000_000n });
    const junk: UTxO = { ...escrowUtxo(d), output: { address: escrowAddress(0), amount: [ada(5)], plutusData: datumCbor({ int: 1 }) } };
    const found = matchBonds([otherApproval, underfunded, smallDatum, junk, good], price, escrowAddress(0));
    expect(found.map((b) => b.tx_hash)).toEqual([good.input.txHash]);
    expect(found[0]).toMatchObject({ output_index: 0, amount: 5_000_000n, datum: d });
  });
});

describe('bond spends pass the real escrow validator', () => {
  const setup = () => {
    const w = world();
    const d = datum();
    const utxo = escrowUtxo(d);
    w.add(utxo);
    return { w, d, utxo, bond: asBond(utxo, d) };
  };
  const run = async (w: ReturnType<typeof world>, plan: ReturnType<typeof bondSpendPlan>) => evaluateTx(w.env, await buildTx(w.env, plan));
  /** Attack txs are built without evaluation (the honest path would refuse to build them), then evaluated. */
  const attack = async (w: ReturnType<typeof world>, plan: ReturnType<typeof bondSpendPlan>) => evaluateTx(w.env, await buildTx(w.env, plan, FIXED_BUDGET));

  it('refund with the approver as required signer pays the agent', async () => {
    const { w, utxo, bond } = setup();
    const plan = bondSpendPlan(utxo, bond, 'refund', w.executor, NOW);
    expect(plan.requiredSigners).toEqual([APPROVER_PKH]);
    expect(plan.validity).toBeNull();
    expect(plan.outputs[0]).toEqual({ address: AGENT, amount: [{ unit: 'lovelace', quantity: '5000000' }] });
    const r = await run(w, plan);
    expect(r.ok).toBe(true);
    if (r.ok) console.log('bond refund exec units', JSON.stringify(r.budgets));
  });

  it('refund after locked_until needs no signer, only a validity range', async () => {
    const { w, utxo, bond } = setup();
    const plan = bondSpendPlan(utxo, bond, 'refund', w.executor, price.locked_until_ms + 60_000);
    expect(plan.requiredSigners).toEqual([]);
    expect(plan.validity).not.toBeNull();
    expect((await run(w, plan)).ok).toBe(true);
  });

  it('capture pays the sink with the approver as required signer', async () => {
    const { w, utxo, bond } = setup();
    const plan = bondSpendPlan(utxo, bond, 'capture', w.executor, NOW);
    expect(plan.requiredSigners).toEqual([APPROVER_PKH]);
    expect(plan.outputs[0]?.address).toBe(sinkAddress(0));
    expect((await run(w, plan)).ok).toBe(true);
  });

  it('a capture that pays the agent, or a refund without approver before the deadline, fails on chain', async () => {
    const { w, utxo, bond } = setup();
    const toAgent = bondSpendPlan(utxo, bond, 'capture', w.executor, NOW);
    toAgent.outputs[0] = { ...toAgent.outputs[0]!, address: AGENT };
    const r1 = await attack(w, toAgent);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.logs.join('\n')).toContain('b5 ? False');
    const early = bondSpendPlan(utxo, bond, 'refund', w.executor, NOW);
    early.requiredSigners = [];
    const r2 = await attack(w, early);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.logs.join('\n')).toContain('b2 ? False');
  });
});
