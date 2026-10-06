import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type DecisionVectorInputs, decisionVectorCases } from '../scripts/gen-decision-vectors';
import { bytesToHex } from '../src/bytes';
import { type DecisionOutcome, decisionHash, decisionPreimage } from '../src/decision';

const committed: Array<{ name: string; inputs: DecisionVectorInputs; preimage_hex: string; decision_hash: string }> = JSON.parse(
  readFileSync(new URL('./vectors/decision.json', import.meta.url), 'utf8'),
);
const sha256OfHex = (hex: string): string => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const A = 'dd'.repeat(32);
const M = 'cc'.repeat(32);

describe('committed decision vectors', () => {
  it('match the generator cases', () => {
    expect(committed.map(({ name, inputs }) => ({ name, inputs }))).toEqual(decisionVectorCases());
    expect(committed.length).toBeGreaterThanOrEqual(5);
    expect(new Set(committed.map((v) => v.decision_hash)).size).toBe(committed.length);
  });

  it.each(committed)('$name re-derives byte for byte', ({ inputs, preimage_hex, decision_hash }) => {
    const args = [inputs.action_hash, inputs.mandate_hash, inputs.verification_ref, inputs.outcome] as const;
    expect(bytesToHex(decisionPreimage(...args))).toBe(preimage_hex);
    expect(decisionHash(...args)).toBe(decision_hash);
    expect(sha256OfHex(preimage_hex)).toBe(decision_hash);
  });
});

describe('decisionHash', () => {
  it('matches a hand-assembled preimage: action || mandate || zero verification ref || "ALLOW"', () => {
    const preimage = `${'dd'.repeat(32)}${'cc'.repeat(32)}${'00'.repeat(32)}414c4c4f57`;
    expect(bytesToHex(decisionPreimage(A, M, null, 'ALLOW'))).toBe(preimage);
    expect(decisionHash(A, M, null, 'ALLOW')).toBe(sha256OfHex(preimage));
  });

  it('zero-fills a missing mandate hash alone: action || zero mandate || verification ref || "ALLOW"', () => {
    const V = 'ee'.repeat(32);
    const preimage = `${'dd'.repeat(32)}${'00'.repeat(32)}${'ee'.repeat(32)}414c4c4f57`;
    expect(bytesToHex(decisionPreimage(A, null, V, 'ALLOW'))).toBe(preimage);
    expect(decisionHash(A, null, V, 'ALLOW')).toBe(sha256OfHex(preimage));
  });

  it.each(['allow', 'NEEDS_VERIFICATION', 'ALLOW ', ''])('rejects outcome %j', (outcome) => {
    expect(() => decisionHash(A, M, null, outcome as DecisionOutcome)).toThrow(TypeError);
  });

  it.each<[string, unknown]>([
    ['number', 1],
    ['null', null],
    ['undefined', undefined],
    ['array', ['ALLOW']],
    ['boxed string', Object('ALLOW')],
  ])('rejects a non-string outcome (%s) with a labelled TypeError', (_label, outcome) => {
    expect(() => decisionHash(A, M, null, outcome as DecisionOutcome)).toThrow(TypeError);
    expect(() => decisionHash(A, M, null, outcome as DecisionOutcome)).toThrow(/^outcome: /);
  });

  it.each<[string, unknown]>([
    ['number', 1],
    ['undefined', undefined],
    ['object', {}],
    ['array', ['dd'.repeat(32)]],
    ['bytes', new Uint8Array(32)],
  ])('rejects a non-string %s hash part with a labelled TypeError', (_label, part) => {
    const hex = part as string;
    expect(() => decisionHash(hex, M, null, 'ALLOW')).toThrow(TypeError);
    expect(() => decisionHash(hex, M, null, 'ALLOW')).toThrow(/^actionHash: /);
    expect(() => decisionHash(A, hex, null, 'ALLOW')).toThrow(/^mandateHash: /);
    expect(() => decisionHash(A, M, hex, 'ALLOW')).toThrow(/^verificationRef: /);
  });

  it.each([
    ['short', 'dd'],
    ['uppercase', 'DD'.repeat(32)],
    ['non-hex', 'zz'.repeat(32)],
    ['0x-prefixed', `0x${'dd'.repeat(31)}`],
  ])('rejects a %s hash in every position', (_label, hex) => {
    expect(() => decisionHash(hex, M, null, 'ALLOW')).toThrow(TypeError);
    expect(() => decisionHash(A, hex, null, 'ALLOW')).toThrow(TypeError);
    expect(() => decisionHash(A, M, hex, 'ALLOW')).toThrow(TypeError);
  });
});
