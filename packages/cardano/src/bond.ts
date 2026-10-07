import { type EscalationPrice, bytesToHex, parseShelleyAddress, sha256Hex } from '@authority/core';
import { type UTxO, pubKeyAddress, resolveTxHash, serializeAddressObj } from '@meshsdk/core';
import { escrowScript, sinkScript } from './blueprint';
import { type Wallet, buildTx } from './build';
import { type Chain, slotAt } from './chain';
import { BOND_CAPTURE, BOND_REFUND, type BondDatum, bondDatumData, parseBondDatum } from './data';

export type { BondDatum } from './data';
import { quantityOf } from './state';
import { UPPER_OFFSET_MS, emptyPlan } from './txs';
import { type SigningWallet, signAndSubmit } from './wallet';

/*
 * Escalation bond (escrow). The agent locks a bond before a human is interrupted. The escrow validator
 * (contracts/cardano/validators/escalation_bond.ak) releases it two ways:
 *   Refund  - approver signature present, or the tx validity range starts after locked_until: back to the agent.
 *   Capture - approver signature present: the full amount goes to the sink (an always-fail script address).
 * Nobody but the agent (refund) or the sink (capture) can ever receive the bond. The approver receives nothing.
 */

export interface BondUtxo {
  tx_hash: string;
  output_index: number;
  datum: BondDatum;
  amount: bigint;
  escrow_address: string;
}

export type BondOutcome = 'refund' | 'capture';

type ChainTag = 0 | 1;
type BondPrice = Pick<EscalationPrice, 'approval_id' | 'action_hash' | 'amount' | 'approver_key_hash' | 'network'> & Partial<Pick<EscalationPrice, 'asset'>>;

/** Bonds carry no mandate_ref in the 402 price yet; the datum field is zero until the price binds one. */
const NO_MANDATE_REF = '00'.repeat(28);

/** The escrow script address for a network. One escrow script per network; the sink hash is a parameter. */
export function escrowAddress(chainTag: ChainTag): string {
  return escrowScript(chainTag).address;
}

/** The sink: an always-fail script address. Captured bonds go here and can never be spent. */
export function sinkAddress(chainTag: ChainTag): string {
  return sinkScript(chainTag).address;
}

export const approvalRef = (approvalId: string): string => sha256Hex(approvalId);

const chainTagOf = (price: Pick<EscalationPrice, 'network'>): ChainTag => (price.network === 'cardano-mainnet' ? 1 : 0);

/** Mesh asset unit of the bond: 'lovelace' for ADA, policy + name otherwise. */
const unitOf = (asset: EscalationPrice['asset'] | undefined): string => (asset?.policy_id ? asset.policy_id + asset.asset_name : 'lovelace');

/** The agent's key hashes from its bech32 address; the escrow rebuilds the address from them, so a script stake credential cannot be refunded. */
export function agentKeys(address: string): { pkh: string; stake: string | null } {
  const a = parseShelleyAddress(address);
  if (a.payment.tag !== 'key') throw new Error('agent address must be a key address');
  if (a.stake !== null && a.stake.tag !== 'key') throw new Error('agent address must not use a script stake credential');
  return { pkh: bytesToHex(a.payment.hash), stake: a.stake === null ? null : bytesToHex(a.stake.hash) };
}

const agentAddress = (d: BondDatum, chainTag: ChainTag): string => serializeAddressObj(pubKeyAddress(d.agent_pkh, d.agent_stake ?? undefined), chainTag);

export function bondDatumFor(price: EscalationPrice, agent: { pkh: string; stake: string | null }, mandateRef: string = NO_MANDATE_REF): BondDatum {
  return {
    approval_ref: approvalRef(price.approval_id),
    action_hash: price.action_hash,
    mandate_ref: mandateRef,
    agent_pkh: agent.pkh,
    agent_stake: agent.stake,
    approver_pkh: price.approver_key_hash,
    amount: BigInt(price.amount),
    locked_until_ms: price.locked_until_ms,
  };
}

/** The lock output: the bond at the escrow address with its inline datum (output 0 of the lock tx). */
export function bondLockOutput(price: EscalationPrice, agent: { pkh: string; stake: string | null }) {
  const tag = chainTagOf(price);
  if (price.escrow_address !== escrowAddress(tag)) throw new Error(`escrow address ${price.escrow_address} is not the ${price.network} escrow script`);
  const datum = bondDatumFor(price, agent);
  return { datum, output: { address: price.escrow_address, amount: [{ unit: unitOf(price.asset), quantity: price.amount }], datum: bondDatumData(datum) } };
}

/** Builds, signs with the agent wallet and submits the lock. Returns the escrow UTxO. */
export async function lockBond(chain: Chain, agent: SigningWallet, price: EscalationPrice): Promise<BondUtxo> {
  const { datum, output } = bondLockOutput(price, agentKeys(agent.address));
  const plan = emptyPlan(await agent.snapshot());
  plan.outputs = [output];
  const tx_hash = await signAndSubmit(chain, await buildTx(chain, plan), [agent]);
  return { tx_hash, output_index: 0, datum, amount: datum.amount, escrow_address: price.escrow_address };
}

/** The escrow UTxOs that match a price, in address order. Exported for offline tests; `readBond` takes the first. */
export function matchBonds(utxos: UTxO[], price: BondPrice, escrow_address: string): BondUtxo[] {
  const ref = approvalRef(price.approval_id);
  const unit = unitOf(price.asset);
  const found: BondUtxo[] = [];
  for (const u of utxos) {
    if (typeof u.output.plutusData !== 'string') continue;
    let d: BondDatum;
    try {
      d = parseBondDatum(u.output.plutusData);
    } catch {
      continue;
    }
    const matches = d.approval_ref === ref && d.action_hash === price.action_hash && d.approver_pkh === price.approver_key_hash && d.amount >= BigInt(price.amount);
    if (matches && quantityOf(u, unit) >= d.amount) {
      found.push({ tx_hash: u.input.txHash, output_index: u.input.outputIndex, datum: d, amount: quantityOf(u, unit), escrow_address });
    }
  }
  return found;
}

/** The live escrow UTxO for this approval at the escrow address, or null. Verifies datum fields against the price. */
export async function readBond(chain: Chain, price: BondPrice): Promise<BondUtxo | null> {
  const address = escrowAddress(chainTagOf(price));
  return matchBonds((await chain.provider.fetchAddressUTxOs(address)) as UTxO[], price, address)[0] ?? null;
}

/** The spend plan: Refund pays the agent, Capture pays the sink. Pure, so tests evaluate it offline. */
export function bondSpendPlan(utxo: UTxO, bond: BondUtxo, outcome: BondOutcome, wallet: Wallet, nowMs: number) {
  // The escrow address names the network; the agent address and sink are rebuilt on the same one.
  const tag = parseShelleyAddress(bond.escrow_address).network;
  const d = bond.datum;
  // Same rule as the validator: the one native token the escrow UTxO holds, or lovelace.
  const unit = utxo.output.amount.find((a) => a.unit !== 'lovelace')?.unit ?? 'lovelace';
  const plan = emptyPlan(wallet);
  plan.scriptInputs = [{ utxo, redeemer: outcome === 'refund' ? BOND_REFUND : BOND_CAPTURE, script: { inline: escrowScript(tag).cbor } }];
  plan.outputs = [{ address: outcome === 'refund' ? agentAddress(d, tag) : sinkAddress(tag), amount: [{ unit, quantity: d.amount.toString() }] }];
  // After locked_until the agent gets its bond back without the approver: the validity range proves the time.
  if (outcome === 'refund' && nowMs > d.locked_until_ms) {
    plan.validity = { lowerSlot: slotAt(nowMs - 1_000), upperSlot: slotAt(nowMs + UPPER_OFFSET_MS) };
  } else {
    plan.requiredSigners = [d.approver_pkh];
  }
  return plan;
}

/**
 * Unsigned tx spending the bond with Refund or Capture. The approver key hash is a required signer, so the
 * approver's CIP-30 wallet signs it (alone, or as part of the release tx when the release builder merges it).
 * A refund after locked_until needs no approver: it carries a validity range instead.
 */
export async function buildBondSpend(
  chain: Chain,
  feeWallet: SigningWallet,
  bond: BondUtxo,
  outcome: BondOutcome,
): Promise<{ txCbor: string; txHash: string }> {
  const utxos = (await chain.provider.fetchAddressUTxOs(bond.escrow_address)) as UTxO[];
  const utxo = utxos.find((u) => u.input.txHash === bond.tx_hash && u.input.outputIndex === bond.output_index);
  if (!utxo) throw new Error(`bond ${bond.tx_hash}#${bond.output_index} is not at ${bond.escrow_address} (already spent?)`);
  const txCbor = await buildTx(chain, bondSpendPlan(utxo, bond, outcome, await feeWallet.snapshot(), Date.now()));
  return { txCbor, txHash: resolveTxHash(txCbor) };
}
