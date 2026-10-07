import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// I1: Attack Lab code can never load an M-001 key (engine, approver or the human admin's identity).
const LAB = readFileSync(new URL('../src/lab.ts', import.meta.url), 'utf8');
const RUNNER = readFileSync(new URL('../../../scripts/cardano-lab.ts', import.meta.url), 'utf8');
const ALLOWED = /^(M_LAB_[A-Z_]+|FEE_WALLET_MNEMONIC|BLOCKFROST_PROJECT_ID_PREPROD|DEMO_VENDOR_AWS_ADDRESS)$/;

describe('Attack Lab key isolation', () => {
  it('the lab module reads no environment at all', () => {
    expect(LAB).not.toMatch(/process\.env/);
  });
  it('the lab runner reads only M-LAB keys, the fee wallet and Blockfrost', () => {
    const names = [...RUNNER.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).toMatch(ALLOWED);
    expect(RUNNER).not.toMatch(/M001_|CFO_TEST_MNEMONIC|CFO_HUMAN|process\.env\[/);
  });
});
