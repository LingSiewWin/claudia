import { describe, expect, it } from 'vitest';
import {
  type AuthorizationFields,
  encodeAuthorization,
  fieldsFromRecord,
  signAuthorization,
  verifyAuthorizationRecord,
} from '../src/authorization';
import { bytesToHex, utf8ToBytes } from '../src/bytes';
import { publicKeyFromSecret } from '../src/ed25519';
import { buildAddress } from './helpers/address-builder';

const engineSk = new Uint8Array(32).fill(1);
const enginePk = bytesToHex(publicKeyFromSecret(engineSk));
const recipient = buildAddress(0x60, new Uint8Array(28).fill(0x11));

const base: AuthorizationFields = {
  chainTag: 0,
  vaultHash: 'aa'.repeat(28),
  mandateRef: 'bb'.repeat(28),
  mandateHash: 'cc'.repeat(32),
  mandateVersion: 3,
  actionHash: 'dd'.repeat(32),
  actionType: 1,
  assetPolicy: 'ee'.repeat(28),
  assetName: '745553444d',
  amount: 8_420_000_000n,
  recipient,
  nonce: 1n,
  validUntil: 1_800_000_000_000n,
  requiresPrincipal: false,
  verificationRef: null,
};

const be = (value: bigint, bytes: number) => value.toString(16).padStart(bytes * 2, '0');

describe('encodeAuthorization', () => {
  it('matches bytes assembled independently from spec 02', () => {
    const expected = [
      bytesToHex(utf8ToBytes('AGENT_AUTHORIZATION_V1')),
      '00',
      'aa'.repeat(28),
      'bb'.repeat(28),
      'cc'.repeat(32),
      be(3n, 4),
      'dd'.repeat(32),
      '01',
      'ee'.repeat(28),
      '05',
      '745553444d',
      be(8_420_000_000n, 8),
      '00' + '11'.repeat(28),
      '00',
      be(1n, 8),
      be(1_800_000_000_000n, 8),
      '00',
      '00'.repeat(32),
    ].join('');
    expect(bytesToHex(encodeAuthorization(base))).toBe(expected);
  });

  it('encodes a script recipient with script stake credential', () => {
    const addr = buildAddress(0x30, new Uint8Array(28).fill(0x33), new Uint8Array(28).fill(0x44));
    const hex = bytesToHex(encodeAuthorization({ ...base, recipient: addr }));
    expect(hex).toContain('01' + '33'.repeat(28) + '02' + '44'.repeat(28));
  });

  it.each([
    ['vaultHash', { vaultHash: 'aa'.repeat(27) }],
    ['mandateVersion 0', { mandateVersion: 0 }],
    ['actionType 0', { actionType: 0 }],
    ['asset name 33 bytes', { assetName: 'ab'.repeat(33) }],
    ['asset name odd hex', { assetName: 'abc' }],
    ['amount 0', { amount: 0n }],
    ['amount 2^64', { amount: 1n << 64n }],
    ['nonce 0', { nonce: 0n }],
    ['mainnet recipient on preprod', { recipient: buildAddress(0x61, new Uint8Array(28).fill(0x11)) }],
    ['verificationRef short', { verificationRef: 'ab' }],
  ] as const)('rejects invalid field: %s', (_label, patch) => {
    expect(() => encodeAuthorization({ ...base, ...patch } as AuthorizationFields)).toThrow();
  });
});

describe('signAuthorization / verifyAuthorizationRecord', () => {
  it('round-trips', () => {
    const record = signAuthorization(base, engineSk);
    expect(record.engine_public_key).toBe(enginePk);
    expect(verifyAuthorizationRecord(record, enginePk)).toBe(true);
    expect(fieldsFromRecord(record)).toEqual(base);
  });

  it('fails if any field is tampered after signing', () => {
    const record = signAuthorization(base, engineSk);
    const tampered = { ...record, fields: { ...record.fields, amount: '84200000000' } };
    expect(verifyAuthorizationRecord(tampered, enginePk)).toBe(false);
    const swapped = { ...record, fields: { ...record.fields, recipient: buildAddress(0x60, new Uint8Array(28).fill(0x99)) } };
    expect(verifyAuthorizationRecord(swapped, enginePk)).toBe(false);
  });

  it('fails for a different engine key', () => {
    const other = bytesToHex(publicKeyFromSecret(new Uint8Array(32).fill(9)));
    expect(verifyAuthorizationRecord(signAuthorization(base, engineSk), other)).toBe(false);
  });
});
