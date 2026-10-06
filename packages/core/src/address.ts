import { bech32 } from '@scure/base';

export type CredentialTag = 'key' | 'script';
export interface Credential {
  tag: CredentialTag;
  hash: Uint8Array;
}
export interface ShelleyAddress {
  network: 0 | 1;
  payment: Credential;
  stake: Credential | null;
}

// CIP-19 header high nibble -> credential kinds. Pointer (4, 5), Byron (8) and reward (14, 15) are not payable here.
const LAYOUT: Record<number, { payment: CredentialTag; stake: CredentialTag | null }> = {
  0x0: { payment: 'key', stake: 'key' },
  0x1: { payment: 'script', stake: 'key' },
  0x2: { payment: 'key', stake: 'script' },
  0x3: { payment: 'script', stake: 'script' },
  0x6: { payment: 'key', stake: null },
  0x7: { payment: 'script', stake: null },
};

export function parseShelleyAddress(address: string): ShelleyAddress {
  let prefix: string;
  let bytes: Uint8Array;
  try {
    const decoded = bech32.decode(address as `${string}1${string}`, 1000);
    prefix = decoded.prefix;
    bytes = bech32.fromWords(decoded.words);
  } catch {
    throw new TypeError('address: invalid bech32');
  }
  const header = bytes[0];
  if (header === undefined) throw new TypeError('address: empty payload');
  const layout = LAYOUT[header >> 4];
  if (!layout) throw new TypeError(`address: unsupported address type ${header >> 4}`);
  const network = header & 0x0f;
  if (network !== 0 && network !== 1) throw new TypeError('address: unknown network id');
  if (prefix !== (network === 0 ? 'addr_test' : 'addr')) throw new TypeError('address: prefix does not match network');
  if (bytes.length !== (layout.stake ? 57 : 29)) throw new TypeError('address: wrong length');
  return {
    network,
    payment: { tag: layout.payment, hash: bytes.slice(1, 29) },
    stake: layout.stake ? { tag: layout.stake, hash: bytes.slice(29, 57) } : null,
  };
}
