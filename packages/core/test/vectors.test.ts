import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_TEST_SECRET, vectorCases } from '../scripts/gen-vectors';
import { type AuthorizationRecord, signAuthorization, verifyAuthorizationRecord } from '../src/authorization';
import { bytesToHex } from '../src/bytes';
import { publicKeyFromSecret } from '../src/ed25519';

const committed: Array<{ name: string; record: AuthorizationRecord }> = JSON.parse(
  readFileSync(new URL('./vectors/authorization.json', import.meta.url), 'utf8'),
);
const enginePk = bytesToHex(publicKeyFromSecret(ENGINE_TEST_SECRET));

describe('committed authorization vectors', () => {
  it('has all 8 cases', () => {
    expect(committed.map((v) => v.name)).toEqual(vectorCases().map((c) => c.name));
  });

  it.each(vectorCases())('$name re-derives byte for byte and verifies', ({ name, fields }) => {
    const vector = committed.find((v) => v.name === name);
    expect(vector).toBeDefined();
    expect(signAuthorization(fields, ENGINE_TEST_SECRET)).toEqual(vector?.record);
    expect(verifyAuthorizationRecord(vector!.record, enginePk)).toBe(true);
  });
});
