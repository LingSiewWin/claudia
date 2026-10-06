import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, concatBytes, hexToBytes, utf8ToBytes };

export function uintBE(value: bigint, size: number): Uint8Array {
  if (value < 0n) throw new RangeError('uintBE: negative value');
  if (value >= 1n << BigInt(size * 8)) throw new RangeError(`uintBE: value does not fit in ${size} bytes`);
  const out = new Uint8Array(size);
  let rest = value;
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function hexOfLength(hex: string, bytes: number, label: string): Uint8Array {
  if (hex.length !== bytes * 2 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError(`${label}: expected ${bytes} bytes of hex`);
  }
  return hexToBytes(hex);
}
