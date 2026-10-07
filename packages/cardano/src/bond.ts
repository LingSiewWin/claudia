import type { EscalationPrice } from '@authority/core';
import type { Chain } from './chain';
import type { SigningWallet } from './wallet';

/*
 * Escalation bond (escrow) seam. The agent locks a bond before a human is interrupted. The escrow validator
 * (contracts/cardano/validators/escalation_bond.ak) releases it three ways:
 *   Refund  - approver signature present, or the tx validity range starts after locked_until: back to the agent.
 *   Capture - approver signature present: the full amount goes to the sink (an always-fail script address).
 * Nobody but the agent (refund) or the sink (capture) can ever receive the bond. The approver receives nothing.
 */

export interface BondDatum {
  /** sha256(utf8(approval_id)) */
  approval_ref: string;
  action_hash: string;
  mandate_ref: string;
  agent_pkh: string;
  agent_stake: string | null;
  approver_pkh: string;
  amount: bigint;
  locked_until_ms: number;
}

export interface BondUtxo {
  tx_hash: string;
  output_index: number;
  datum: BondDatum;
  amount: bigint;
  escrow_address: string;
}

export type BondOutcome = 'refund' | 'capture';

const TODO = (what: string) => new Error(`NotImplemented: ${what} (P3 escalation bond lane)`);

/** The escrow script address for a network. One escrow script per network; the sink hash is a parameter. */
export function escrowAddress(_chainTag: 0 | 1): string {
  throw TODO('escrowAddress');
}

/** The sink: an always-fail script address. Captured bonds go here and can never be spent. */
export function sinkAddress(_chainTag: 0 | 1): string {
  throw TODO('sinkAddress');
}

export const approvalRef = (_approvalId: string): string => {
  throw TODO('approvalRef');
};

export function bondDatumFor(_price: EscalationPrice, _agent: { pkh: string; stake: string | null }): BondDatum {
  throw TODO('bondDatumFor');
}

/** Builds, signs with the agent wallet and submits the lock. Returns the escrow UTxO. */
export async function lockBond(_chain: Chain, _agent: SigningWallet, _price: EscalationPrice): Promise<BondUtxo> {
  throw TODO('lockBond');
}

/** The live escrow UTxO for this approval at the escrow address, or null. Verifies datum fields against the price. */
export async function readBond(_chain: Chain, _price: Pick<EscalationPrice, 'approval_id' | 'action_hash' | 'amount' | 'approver_key_hash'>): Promise<BondUtxo | null> {
  throw TODO('readBond');
}

/**
 * Unsigned tx spending the bond with Refund or Capture. The approver key hash is a required signer, so the
 * approver's CIP-30 wallet signs it (alone, or as part of the release tx when the release builder merges it).
 */
export async function buildBondSpend(
  _chain: Chain,
  _feeWallet: SigningWallet,
  _bond: BondUtxo,
  _outcome: BondOutcome,
): Promise<{ txCbor: string; txHash: string }> {
  throw TODO('buildBondSpend');
}
