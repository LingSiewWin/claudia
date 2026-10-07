import { MeshWallet, type UTxO, core, deserializeAddress, resolveTxHash } from '@meshsdk/core';
import type { Wallet } from './build';
import { type Chain, awaitTx, submit } from './chain';

/** A key wallet the scripts and the executor sign with. The mnemonic comes from one env var and is never printed. */
export interface SigningWallet {
  address: string;
  pkh: string;
  snapshot(): Promise<Wallet>;
  sign(txHex: string): Promise<string>;
}

export async function walletFromMnemonic(chain: Chain, words: string | undefined, envName: string): Promise<SigningWallet> {
  const list = (words ?? '').trim().split(/\s+/);
  if (![12, 15, 24].includes(list.length)) throw new Error(`${envName} must hold a 12, 15 or 24 word mnemonic`);
  const mesh = new MeshWallet({ networkId: 0, fetcher: chain.provider, submitter: chain.provider, key: { type: 'mnemonic', words: list } });
  await mesh.init();
  const address = await mesh.getChangeAddress();
  return {
    address,
    pkh: deserializeAddress(address).pubKeyHash,
    snapshot: async () => ({ address, utxos: (await chain.provider.fetchAddressUTxOs(address)) as UTxO[] }),
    sign: (txHex) => mesh.signTx(txHex, true),
  };
}

/** A wallet that only reads (the CIP-30 admin wallet: the CLI never holds its key). */
export const watchWallet = (chain: Chain, address: string) => ({
  address,
  pkh: deserializeAddress(address).pubKeyHash,
  snapshot: async (): Promise<Wallet> => ({ address, utxos: (await chain.provider.fetchAddressUTxOs(address)) as UTxO[] }),
});

export const newMnemonic = (): string => (MeshWallet.brew() as string[]).join(' ');

/** Adds each wallet's witness, submits, and waits until the tx is in a block. */
export async function signAndSubmit(chain: Chain, txHex: string, signers: SigningWallet[]): Promise<string> {
  let tx = txHex;
  for (const s of signers) tx = await s.sign(tx);
  const hash = await submit(chain, tx);
  await awaitTx(chain, hash);
  return hash;
}

/** Merges a CIP-30 `signTx(tx, true)` result (a witness set) into the tx; the body and its hash are unchanged. */
export const addWitnessSet = (txHex: string, witnessSetHex: string): string => core.addVKeyWitnessSetToTransaction(txHex, witnessSetHex);

/** Key hashes of the vkey witnesses a tx carries. */
export const vkeyHashes = (txHex: string): string[] =>
  (core.deserializeTx(txHex).witnessSet().vkeys()?.values() ?? []).map((k) => core.Ed25519PublicKey.fromHex(k.vkey()).hash().hex());

/**
 * Merges a witness set returned by a browser wallet, and refuses it unless the body is unchanged and the
 * set adds a witness by `expectedPkh` (the key the plan named as required signer).
 */
export function mergeWitness(txHex: string, witnessSetHex: string, expectedPkh: string): string {
  const merged = addWitnessSet(txHex, witnessSetHex);
  if (resolveTxHash(merged) !== resolveTxHash(txHex)) throw new Error('witness merge changed the tx body');
  const before = new Set(vkeyHashes(txHex));
  const added = vkeyHashes(merged).filter((h) => !before.has(h));
  if (!added.includes(expectedPkh)) throw new Error(`wallet witness does not sign as ${expectedPkh} (got ${added.join(', ') || 'none'})`);
  return merged;
}
