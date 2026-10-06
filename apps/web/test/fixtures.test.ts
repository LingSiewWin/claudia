import { canonicalJson, concatBytes, hexToBytes, sha256Hex, utf8ToBytes } from '@authority/core';
import { describe, expect, it } from 'vitest';
import { formatUnits } from '../lib/format';
import { recorded, stage } from './load';

describe('recorded fixtures', () => {
  it('form one hash chain across every run (spec 07 event hash)', () => {
    const all = Object.values(recorded.logs)
      .flat()
      .sort((a, b) => a.seq - b.seq);
    let prev = '00'.repeat(32);
    for (const e of all) {
      const { hash, prev_hash, ...body } = e;
      expect(prev_hash).toBe(prev);
      expect(sha256Hex(concatBytes(hexToBytes(prev), utf8ToBytes(canonicalJson(body))))).toBe(hash);
      prev = hash;
    }
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  });

  it('replay the scaled stage run with one reason per denial', () => {
    const denials = stage().flatMap((e) =>
      e.type === 'ActionDenied' ? [`${e.action_id}:${e.payload.reason}`] : e.type === 'CFODeclined' ? [`${e.action_id}:PRINCIPAL_DECLINED`] : [],
    );
    expect(denials).toEqual([
      'A-0003:PRINCIPAL_DECLINED',
      'A-0004:AMOUNT_ABOVE_HARD_CAP',
      'A-0005:PURPOSE_NOT_AUTHORIZED',
      'A-0006:RECIPIENT_MISMATCH',
      'A-0007:TREASURY_FLOOR_VIOLATION',
    ]);
    const vault = recorded.mandates['M-001']!.vault;
    expect([formatUnits(vault.balance), formatUnits(vault.spent_today)]).toEqual(['108.58', '26.42']);
  });

  it('contain no secret-looking material', () => {
    expect(JSON.stringify(recorded)).not.toMatch(/mnemonic|-----BEGIN|xprv|secret_key|ed25519_sk/i);
  });
});
