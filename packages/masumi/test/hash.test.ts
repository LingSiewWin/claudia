import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type DecisionOutcome,
  decisionHash,
  isPurchaserId,
  masumiResultHashV0,
  mip004InputHash,
  mip004ResultHashEscaped,
  mip004ResultHashRaw,
} from '../src/index';

const ID = 'aabbccddeeff00112233';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// Input hashes and the escaped result hashes of the first four result rows were produced by Masumi's own code:
// Sokosumi packages/masumi/src/hash/hash.ts (hashInput, hashResult) and pip-masumi helper_functions.py
// (create_masumi_input_hash, create_masumi_output_hash). Both implementations returned identical digests for every row.
describe('MIP-004 input hash', () => {
  it.each([
    [
      'unsorted keys, nested object, non-ASCII',
      { request_text: 'Pay AWS invoice INV-M-0001 — 8.42 USDM', mandate_id: 'M-001', proposal: { agent_signature: null, action: { id: 'A-M-0001', amount: '8.42' } } },
      ID,
      '9bbb6f17187387071cd6a2a9fe2aa3f1520d1421c64c396c5585b61555470ca7',
    ],
    [
      'Sokosumi Task input',
      { taskId: '01a10ef7-d2cf-73d8-b084-47898de89fce', name: 'Authority Check', description: '{"mandate_id":"M-001","request_text":"Pay AWS invoice INV-M-0001"}' },
      ID,
      '7d28637f03c8bde66ff66eecd9919f1cae02d27c96b27d0c678295bc04a167f9',
    ],
    ['Masumi reference worker vector', { prompt: 'Cardano payments' }, 'aabbccddeeff0011', '25f3afe66b39b0582711c9faf53930c7b6a6feffd10294750ec77be47fd63080'],
  ])('%s', (_label, input, id, expected) => {
    expect(mip004InputHash(input, id)).toBe(expected);
  });
});

// Raw hashes are sha256("<id>;<output>") as the MIP-004 text writes it, rechecked below with node:crypto.
describe('MIP-004 result hash, raw and escaped', () => {
  it.each([
    ['canonical JSON output', '{"decision":"ALLOW","reason":null}', ID, '77a755de31ce8bec9c592ac27b86f6637a762a93be955ea527a609a3efe2178d', '3822c58f161178683ebaf95c3820e76f6a2017e7ae978e0b9d82880e50aa2f26'],
    ['newline, quotes, backslash', 'line\n"next"\\end', '01234567890123456789', '7274791448dbdd3200d56594716830eec96cc7e4929e90a1f5d005dbbd3c1dcd', '36767ae2635033ebfa81d977b51a72b9d9ea541c73c9c7e6f55302543ba97db3'],
    ['newline only', 'Line 1\nLine 2', 'aabbccddeeff0011', '6fa3bfa69364318f78619b87652c725d705c90f18f8bdcb5d7041c17b73ea57a', '85ba9cdbfafd6984e7a57a04c2e0fe378f48b998e327aa851b4e5459b990fb19'],
    ['control char, U+2028, non-ASCII and emoji', 'tab\there\u0001 \u2028 é \u{1F600} "q" \\', ID, '8fd80882f98d771b95d05a02387712db4a1cafcef06ee4154454624bb0d1dc80', '01c8a142954402b20e9f6d13a775790ac518af8f0966a7fe8e066b7c8a6ee858'],
    ['no quotes, backslashes or control chars', 'Payment approved: 8.42 USDM to AWS (demo vendor) — é \u{1F600}', ID, '5e81971ea19c6bbffd6b389f1cc59c9109f394ad3c39f02d4bcf743fc4292843', '5e81971ea19c6bbffd6b389f1cc59c9109f394ad3c39f02d4bcf743fc4292843'],
  ])('%s', (_label, result, id, raw, escaped) => {
    expect(mip004ResultHashRaw(result, id)).toBe(raw);
    expect(sha(`${id};${result}`)).toBe(raw);
    expect(mip004ResultHashEscaped(result, id)).toBe(escaped);
    expect(masumiResultHashV0(result, id)).toEqual({ raw_output_hash: raw, escaped_json_hash: escaped });
    // The two forms agree exactly when the output contains nothing that JSON escapes.
    expect(raw === escaped).toBe(!/["\\\x00-\x1f]/.test(result));
  });
});

describe('identifierFromPurchaser', () => {
  it.each(['aabbccddeeff00', 'AABBCCDDEEFF0011', 'a'.repeat(26)])('accepts %s', (id) => expect(isPurchaserId(id)).toBe(true));
  it.each(['', 'aabbccddeeff0', 'a'.repeat(15), 'a'.repeat(28), 'zzbbccddeeff0011', 'resume-job-123'])('rejects %s', (id) => {
    expect(isPurchaserId(id)).toBe(false);
    expect(() => mip004ResultHashRaw('x', id)).toThrow();
    expect(() => mip004ResultHashEscaped('x', id)).toThrow();
    expect(() => mip004InputHash({}, id)).toThrow();
  });
});

type DecisionVector = {
  name: string;
  inputs: { action_hash: string | null; mandate_hash: string | null; verification_ref: string | null; outcome: DecisionOutcome };
  decision_hash: string;
};
const decisionVectors: DecisionVector[] = JSON.parse(
  readFileSync(new URL('../../core/test/vectors/decision.json', import.meta.url), 'utf8'),
);

describe('decisionHash from @authority/core', () => {
  it('loads the shared vectors', () => expect(decisionVectors.length).toBeGreaterThanOrEqual(5));

  it.each(decisionVectors)('$name matches the shared vector', ({ inputs, decision_hash }) => {
    expect(decisionHash(inputs.action_hash, inputs.mandate_hash, inputs.verification_ref, inputs.outcome)).toBe(decision_hash);
  });
});
