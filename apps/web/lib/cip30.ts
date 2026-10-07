import { bytesToHex, hexToBytes } from '@authority/core';

// CIP-30 (cardano-foundation/CIPs, CIP-0030): addresses are hex-encoded bytes, signTx returns a witness set,
// signData(addr, payload hex) returns a CIP-8 DataSignature signed with the payment key of `addr`.
export interface Cip30Api {
  getNetworkId(): Promise<number>;
  getUsedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  signData(addr: string, payload: string): Promise<{ signature: string; key: string }>;
}
export interface Cip30Wallet {
  name: string;
  icon: string;
  apiVersion: string;
  enable(): Promise<Cip30Api>;
}
declare global {
  interface Window {
    cardano?: Record<string, Cip30Wallet | undefined>;
  }
}

export interface WalletChoice {
  key: string;
  name: string;
  icon: string;
}

export function injectedWallets(): WalletChoice[] {
  const injected = typeof window === 'undefined' ? undefined : window.cardano;
  if (!injected) return [];
  return Object.entries(injected).flatMap(([key, w]) =>
    w && typeof w.enable === 'function' && typeof w.name === 'string' ? [{ key, name: w.name, icon: w.icon }] : [],
  );
}

/** Payment key hash (56 hex) of a hex-encoded Shelley address with a key payment credential, else null. */
export function paymentKeyHash(addressHex: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(addressHex);
  } catch {
    return null;
  }
  const header = bytes[0];
  if (header === undefined || bytes.length < 29) return null;
  if (![0x0, 0x2, 0x4, 0x6].includes(header >> 4)) return null;
  return bytesToHex(bytes.slice(1, 29));
}

export interface ConnectedWallet {
  key: string;
  name: string;
  api: Cip30Api;
  networkId: number;
  /** Hex addresses with a key payment credential, and that credential's hash. */
  addresses: Array<{ hex: string; keyHash: string }>;
  keyHashes: string[];
}

export async function connectWallet(key: string): Promise<ConnectedWallet> {
  const wallet = window.cardano?.[key];
  if (!wallet) throw new Error(`Wallet "${key}" is not installed in this browser.`);
  const api = await wallet.enable();
  const [networkId, used, change] = await Promise.all([api.getNetworkId(), api.getUsedAddresses(), api.getChangeAddress()]);
  const addresses = [...new Set([...used, change])].flatMap((hex) => {
    const keyHash = paymentKeyHash(hex);
    return keyHash ? [{ hex, keyHash }] : [];
  });
  const keyHashes = [...new Set(addresses.map((a) => a.keyHash))];
  return { key, name: wallet.name, api, networkId, addresses, keyHashes };
}

/**
 * Plain-words text for CIP-30 errors ({ code, info }). Sign codes differ by call:
 * TxSignError 1 ProofGeneration, 2 UserDeclined; DataSignError 1 ProofGeneration, 2 AddressNotPK, 3 UserDeclined.
 */
export function walletErrorText(err: unknown, call: 'signTx' | 'signData' = 'signTx'): string {
  const e = err as { code?: unknown; info?: unknown; message?: unknown } | null;
  const declined = call === 'signTx' ? 2 : 3;
  if (e?.code === declined) return 'You declined in the wallet. Nothing was signed.';
  if (call === 'signData' && e?.code === 2) return 'This address cannot sign messages. Use the CFO key address.';
  switch (e?.code) {
    case 1:
      return 'The wallet could not sign with the connected account.';
    case -3:
      return 'The wallet refused the connection.';
    case -4:
      return 'The wallet account changed. Connect again.';
    default:
      return typeof e?.info === 'string' ? e.info : typeof e?.message === 'string' ? e.message : 'Wallet error.';
  }
}
