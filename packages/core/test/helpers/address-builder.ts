import { bech32 } from '@scure/base';

// Builds a bech32 Shelley address directly from CIP-19 bytes, independent of the parser.
export function buildAddress(header: number, payment: Uint8Array, stake?: Uint8Array): string {
  const bytes = stake ? Uint8Array.from([header, ...payment, ...stake]) : Uint8Array.from([header, ...payment]);
  const prefix = (header & 0x0f) === 0 ? 'addr_test' : 'addr';
  return bech32.encode(prefix, bech32.toWords(bytes), 1000);
}
