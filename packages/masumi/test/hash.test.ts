import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decisionHash, isPurchaserId, mip004InputHash, mip004ResultHash } from '../src/hash';

const ID = 'aabbccddeeff00112233';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// Every expected value was produced by Masumi's own code: Sokosumi packages/masumi/src/hash/hash.ts
// (hashInput, hashResult) and pip-masumi helper_functions.py (create_masumi_input_hash,
// create_masumi_output_hash). Both implementations returned identical digests for every row.
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

describe('MIP-004 result hash', () => {
  it.each([
    ['canonical JSON output', '{"decision":"ALLOW","reason":null}', ID, '3822c58f161178683ebaf95c3820e76f6a2017e7ae978e0b9d82880e50aa2f26', '77a755de31ce8bec9c592ac27b86f6637a762a93be955ea527a609a3efe2178d'],
    ['newline, quotes, backslash', 'line\n"next"\\end', '01234567890123456789', '36767ae2635033ebfa81d977b51a72b9d9ea541c73c9c7e6f55302543ba97db3', '7274791448dbdd3200d56594716830eec96cc7e4929e90a1f5d005dbbd3c1dcd'],
    ['newline only', 'Line 1\nLine 2', 'aabbccddeeff0011', '85ba9cdbfafd6984e7a57a04c2e0fe378f48b998e327aa851b4e5459b990fb19', '6fa3bfa69364318f78619b87652c725d705c90f18f8bdcb5d7041c17b73ea57a'],
  ])('%s', (_label, result, id, masumi, rawMipText) => {
    expect(mip004ResultHash(result, id)).toBe(masumi);
    // Raw pre-image as written in the MIP-004 text; Masumi's code does not use it.
    expect(sha(`${id};${result}`)).toBe(rawMipText);
    expect(masumi).not.toBe(rawMipText);
  });

  it('control char, U+2028, non-ASCII and emoji match both Masumi implementations', () => {
    expect(mip004ResultHash('tab\there\u0001   é \u{1F600} "q" \\', ID)).toBe(
      '01c8a142954402b20e9f6d13a775790ac518af8f0966a7fe8e066b7c8a6ee858',
    );
  });
});

describe('identifierFromPurchaser', () => {
  it.each(['aabbccddeeff00', 'AABBCCDDEEFF0011', 'a'.repeat(26)])('accepts %s', (id) => expect(isPurchaserId(id)).toBe(true));
  it.each(['', 'aabbccddeeff0', 'a'.repeat(15), 'a'.repeat(28), 'zzbbccddeeff0011', 'resume-job-123'])('rejects %s', (id) => {
    expect(isPurchaserId(id)).toBe(false);
    expect(() => mip004ResultHash('x', id)).toThrow();
    expect(() => mip004InputHash({}, id)).toThrow();
  });
});

describe('decisionHash', () => {
  it('matches sha256(action || mandate || verification_ref || outcome)', () => {
    expect(decisionHash('dd'.repeat(32), 'cc'.repeat(32), 'ee'.repeat(32), 'ALLOW')).toBe(
      '652822b7d97cdceeeecf8a161a2cbaf75cdabd08baa7be15b665d73dd637f0a0',
    );
  });

  it('uses 32 zero bytes for a missing action hash or verification ref', () => {
    expect(decisionHash(null, 'cc'.repeat(32), null, 'DENY')).toBe('05093e707c81317f4fb234ab111a1be1deaf327ab9824dbc49db77810c569b63');
  });

  it('changes when any part changes', () => {
    const base = decisionHash('dd'.repeat(32), 'cc'.repeat(32), null, 'ALLOW');
    expect(decisionHash('dd'.repeat(32), 'cc'.repeat(32), null, 'DENY')).not.toBe(base);
    expect(decisionHash('dd'.repeat(32), 'cb'.repeat(32), null, 'ALLOW')).not.toBe(base);
    expect(decisionHash('dd'.repeat(32), 'cc'.repeat(32), 'ee'.repeat(32), 'ALLOW')).not.toBe(base);
  });

  it('rejects malformed hashes', () => {
    expect(() => decisionHash('dd', 'cc'.repeat(32), null, 'ALLOW')).toThrow();
  });
});
