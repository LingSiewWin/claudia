import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { parseShelleyAddress } from '../src/address';
import { buildAddress } from './helpers/address-builder';

const pay = new Uint8Array(28).fill(0x11);
const stk = new Uint8Array(28).fill(0x22);

describe('parseShelleyAddress', () => {
  it.each([
    [0x00, 'key', 'key'],
    [0x10, 'script', 'key'],
    [0x20, 'key', 'script'],
    [0x30, 'script', 'script'],
  ] as const)('base address header %i', (header, payTag, stakeTag) => {
    const parsed = parseShelleyAddress(buildAddress(header, pay, stk));
    expect(parsed.network).toBe(0);
    expect(parsed.payment).toEqual({ tag: payTag, hash: pay });
    expect(parsed.stake).toEqual({ tag: stakeTag, hash: stk });
  });

  it.each([
    [0x60, 'key'],
    [0x70, 'script'],
  ] as const)('enterprise address header %i', (header, payTag) => {
    const parsed = parseShelleyAddress(buildAddress(header, pay));
    expect(parsed.payment).toEqual({ tag: payTag, hash: pay });
    expect(parsed.stake).toBeNull();
  });

  it('reads mainnet network id', () => {
    expect(parseShelleyAddress(buildAddress(0x61, pay)).network).toBe(1);
  });

  it('rejects pointer, reward, and unknown types', () => {
    expect(() => parseShelleyAddress(buildAddress(0x40, pay, new Uint8Array(3)))).toThrow(TypeError);
    expect(() => parseShelleyAddress(buildAddress(0xe0, pay))).toThrow(TypeError);
  });

  it('rejects wrong length', () => {
    expect(() => parseShelleyAddress(buildAddress(0x60, new Uint8Array(27)))).toThrow(TypeError);
    expect(() => parseShelleyAddress(buildAddress(0x00, pay))).toThrow(TypeError);
  });

  it('rejects prefix that does not match the network', () => {
    const bytes = Uint8Array.from([0x61, ...pay]);
    const wrong = bech32.encode('addr_test', bech32.toWords(bytes), 1000);
    expect(() => parseShelleyAddress(wrong)).toThrow(TypeError);
  });

  it('rejects garbage', () => {
    expect(() => parseShelleyAddress('not-an-address')).toThrow(TypeError);
    expect(() => parseShelleyAddress('')).toThrow(TypeError);
  });
});
