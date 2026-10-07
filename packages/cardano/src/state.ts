import type { State } from '@authority/core';
import type { IFetcher, UTxO } from '@meshsdk/core';
import { MANDATE_TOKEN, VAULT_TOKEN } from './blueprint';
import { type AnchorDatum, type VaultDatum, parseAnchorDatum, parseVaultDatum } from './data';
import type { Deployment } from './deployment';

export interface AnchorState {
  utxo: UTxO;
  datum: AnchorDatum;
}

export interface VaultState {
  utxo: UTxO;
  datum: VaultDatum;
  /** Settlement-asset quantity of the thread UTxO alone (other UTxOs at the vault address cannot fund a Release). */
  balance: bigint;
}

export const quantityOf = (u: UTxO, unit: string): bigint =>
  BigInt(u.output.amount.find((a) => a.unit === unit)?.quantity ?? '0');

function one(utxos: UTxO[], label: string): UTxO {
  if (utxos.length !== 1 || !utxos[0]?.output.plutusData) throw new Error(`${label}: expected exactly one UTxO with an inline datum, found ${utxos.length}`);
  return utxos[0];
}

export async function readAnchor(fetcher: IFetcher, d: Pick<Deployment, 'mandate_id' | 'anchor'>): Promise<AnchorState> {
  const utxo = one(await fetcher.fetchAddressUTxOs(d.anchor.address, d.anchor.policy + MANDATE_TOKEN), `${d.mandate_id} anchor`);
  return { utxo, datum: parseAnchorDatum(utxo.output.plutusData as string) };
}

export async function readVault(fetcher: IFetcher, d: Pick<Deployment, 'mandate_id' | 'vault' | 'asset'>): Promise<VaultState> {
  const utxo = one(await fetcher.fetchAddressUTxOs(d.vault.address, d.vault.hash + VAULT_TOKEN), `${d.mandate_id} vault`);
  return { utxo, datum: parseVaultDatum(utxo.output.plutusData as string), balance: quantityOf(utxo, d.asset.policy + d.asset.name) };
}

export async function readRefScript(fetcher: IFetcher, d: Deployment): Promise<UTxO> {
  const r = d.vault.ref_script;
  const ref = (await fetcher.fetchAddressUTxOs(r.address)).find((u) => u.input.txHash === r.txHash && u.input.outputIndex === r.outputIndex);
  if (!ref?.output.scriptRef) throw new Error(`${d.mandate_id}: vault reference script ${r.txHash}#${r.outputIndex} not found at ${r.address} (spent, or Blockfrost unavailable)`);
  return ref;
}

/** The engine's view of on-chain state (core `State`): `vault_balance` is the thread UTxO's quantity, never the address total. */
export function engineState(anchor: AnchorState, vault: VaultState, observedAtSlot: number): State {
  return {
    vault_balance: vault.balance.toString(),
    spent_today: vault.datum.spent_today.toString(),
    day_index: Number(vault.datum.day_index),
    last_nonce: vault.datum.last_nonce.toString(),
    anchor_version: anchor.datum.version,
    anchor_status: anchor.datum.status,
    observed_at_slot: observedAtSlot,
  };
}
