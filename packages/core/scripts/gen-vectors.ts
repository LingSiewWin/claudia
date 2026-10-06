import { writeFileSync } from 'node:fs';
import { type AuthorizationFields, signAuthorization } from '../src/authorization';
import { buildAddress } from '../test/helpers/address-builder';

export const ENGINE_TEST_SECRET = new Uint8Array(32).fill(1);
const pay = new Uint8Array(28).fill(0x11);
const stk = new Uint8Array(28).fill(0x22);

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
  recipient: buildAddress(0x60, pay),
  nonce: 1n,
  validUntil: 1_800_000_000_000n,
  requiresPrincipal: false,
  verificationRef: null,
};

export function vectorCases(): Array<{ name: string; fields: AuthorizationFields }> {
  return [
    { name: 'key recipient, no stake', fields: base },
    { name: 'key recipient, key stake', fields: { ...base, recipient: buildAddress(0x00, pay, stk) } },
    { name: 'script recipient, script stake', fields: { ...base, recipient: buildAddress(0x30, pay, stk) } },
    { name: 'empty asset name', fields: { ...base, assetName: '' } },
    { name: '32-byte asset name', fields: { ...base, assetName: 'ab'.repeat(32) } },
    { name: 'max u64 amount', fields: { ...base, amount: (1n << 64n) - 1n } },
    { name: 'amount 1, requires principal', fields: { ...base, amount: 1n, requiresPrincipal: true } },
    { name: 'verification ref set', fields: { ...base, verificationRef: 'f0'.repeat(32), nonce: 42n } },
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const vectors = vectorCases().map(({ name, fields }) => ({ name, record: signAuthorization(fields, ENGINE_TEST_SECRET) }));
  writeFileSync(new URL('../test/vectors/authorization.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
  console.log(`wrote ${vectors.length} vectors`);
}
