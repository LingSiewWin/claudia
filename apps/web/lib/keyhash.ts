import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex } from '@authority/core';

/** Cardano key hash: blake2b-224 of the raw ed25519 public key (hex in, hex out). */
export const keyHash = (publicKeyHex: string): string => {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) throw new Error('expected a 32-byte ed25519 public key in hex');
  return bytesToHex(blake2b(Uint8Array.from(Buffer.from(publicKeyHex, 'hex')), { dkLen: 28 }));
};
