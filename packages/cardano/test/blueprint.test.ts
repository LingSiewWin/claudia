import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anchorScript, compiledCode, vaultScript } from '../src/blueprint';

// The aiken CLI's applied values for the same dummy seeds, pinned by contracts/cardano/scripts/blueprint.mjs.
const REFERENCE = readFileSync(new URL('../../../contracts/cardano/scripts/blueprint.mjs', import.meta.url), 'utf8');
const pinned = (key: string) => new RegExp(`${key}: '([0-9a-z_]+)'`).exec(REFERENCE)?.[1];

describe('blueprint application', () => {
  it('uses one compiled program for mint and spend of each validator', () => {
    expect(compiledCode('mandate_anchor.mandate_anchor.mint')).toBe(compiledCode('mandate_anchor.mandate_anchor.spend'));
    expect(compiledCode('vault.vault.mint')).toBe(compiledCode('vault.vault.spend'));
  });

  it('was built with invariant traces, so a rejected tx names the failing check', () => {
    const hex = (s: string) => Buffer.from(s).toString('hex');
    for (const t of ['r6 ? False', 'r11 ? False', 'r16 ? False', 'w1 ? False']) expect(compiledCode('vault.vault.spend')).toContain(hex(t));
    for (const t of ['m1 ? False', 'update_signed ? False', 'revoke_signed ? False']) expect(compiledCode('mandate_anchor.mandate_anchor.spend')).toContain(hex(t));
  });

  it('binds each script to its parameters exactly as the aiken CLI does', () => {
    const seed = { txHash: 'a5'.repeat(32), outputIndex: 0 };
    const a = anchorScript(seed);
    expect(a.address.startsWith('addr_test1w')).toBe(true);
    expect(anchorScript({ ...seed, outputIndex: 1 }).hash).not.toBe(a.hash);
    const v = vaultScript(a.hash, 0, { txHash: 'b5'.repeat(32), outputIndex: 1 });
    expect(vaultScript(a.hash, 1, { txHash: 'b5'.repeat(32), outputIndex: 1 }).hash).not.toBe(v.hash);
    expect([a.hash, v.hash, v.address]).toEqual([pinned('anchorPolicy'), pinned('vaultPolicy'), pinned('vaultAddress')]);
    console.log('dummy-seed hashes', a.hash, v.hash, v.address);
  });
});
