import { describe, expect, it } from 'vitest';
import { bytesToHex, hexOfLength, uintBE } from '../src/bytes';
import { blake2b256, canonicalHash, sha256Hex } from '../src/hash';

describe('bytes', () => {
  it('encodes unsigned big-endian of exact size', () => {
    expect(bytesToHex(uintBE(3n, 4))).toBe('00000003');
    expect(bytesToHex(uintBE(8_420_000_000n, 8))).toBe(8_420_000_000n.toString(16).padStart(16, '0'));
    expect(bytesToHex(uintBE((1n << 64n) - 1n, 8))).toBe('ffffffffffffffff');
  });

  it('rejects negative and oversized values', () => {
    expect(() => uintBE(-1n, 4)).toThrow(RangeError);
    expect(() => uintBE(1n << 32n, 4)).toThrow(RangeError);
  });

  it('decodes hex of an exact length only', () => {
    expect(hexOfLength('ABcd', 2, 'x')).toEqual(Uint8Array.of(0xab, 0xcd));
    expect(() => hexOfLength('abc', 2, 'x')).toThrow(TypeError);
    expect(() => hexOfLength('abcd', 3, 'x')).toThrow(TypeError);
    expect(() => hexOfLength('zz', 1, 'x')).toThrow(TypeError);
  });
});

describe('hash', () => {
  it('sha256 known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('blake2b-256 known vector', () => {
    expect(bytesToHex(blake2b256(new TextEncoder().encode('abc')))).toBe(
      'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
    );
  });

  it('canonicalHash ignores key order', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });
});
