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

class NotIndexed extends Error {}

const withUnit = (utxos: UTxO[], unit: string): UTxO[] => utxos.filter((u) => quantityOf(u, unit) > 0n);

function one(utxos: UTxO[], label: string): UTxO {
  if (utxos.length !== 1 || !utxos[0]?.output.plutusData) throw new NotIndexed(`${label}: expected exactly one UTxO with an inline datum, found ${utxos.length}`);
  return utxos[0];
}

/**
 * Blockfrost confirms a tx (GET /txs) a few seconds before its address UTxO index catches up, so a read right after
 * awaitTx can miss a UTxO that exists. Retry a not-found read for up to a minute; any other error is thrown at once.
 */
// ponytail: fixed 12 x 5 s poll; make it configurable if a caller needs a tighter budget
async function indexed<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof NotIndexed) || attempt >= 12) throw error;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

export async function readAnchor(fetcher: IFetcher, d: Pick<Deployment, 'mandate_id' | 'anchor'>): Promise<AnchorState> {
  // Unfiltered address read, filtered here: Blockfrost's per-asset UTxO index can lag the address index by a block.
  const utxo = await indexed(async () => one(withUnit(await fetcher.fetchAddressUTxOs(d.anchor.address), d.anchor.policy + MANDATE_TOKEN), `${d.mandate_id} anchor`));
  return { utxo, datum: parseAnchorDatum(utxo.output.plutusData as string) };
}

export async function readVault(fetcher: IFetcher, d: Pick<Deployment, 'mandate_id' | 'vault' | 'asset'>): Promise<VaultState> {
  const utxo = await indexed(async () => one(withUnit(await fetcher.fetchAddressUTxOs(d.vault.address), d.vault.hash + VAULT_TOKEN), `${d.mandate_id} vault`));
  return { utxo, datum: parseVaultDatum(utxo.output.plutusData as string), balance: quantityOf(utxo, d.asset.policy + d.asset.name) };
}

export async function readRefScript(fetcher: IFetcher, d: Deployment): Promise<UTxO> {
  const r = d.vault.ref_script;
  return indexed(async () => {
    const ref = (await fetcher.fetchAddressUTxOs(r.address)).find((u) => u.input.txHash === r.txHash && u.input.outputIndex === r.outputIndex);
    if (!ref?.output.scriptRef) throw new NotIndexed(`${d.mandate_id}: vault reference script ${r.txHash}#${r.outputIndex} not found at ${r.address} (spent, or Blockfrost unavailable)`);
    return ref;
  });
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
