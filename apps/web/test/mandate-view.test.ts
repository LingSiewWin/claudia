import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readMandate, treasuryNote } from '../lib/mandate';
import { recorded } from './load';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('mandate amounts', () => {
  it('drops the spendable clause when the anchor is revoked', () => {
    const m = readMandate(recorded.mandates['M-REVOKED']!);
    expect(m.anchor.status).toBe('revoked');
    expect(treasuryNote(m.anchor.status === 'revoked', m.floor, m.balance, m.limits.decimals)).toBe('minimum $1.00');
  });

  it('keeps spendable headroom while the mandate is active', () => {
    const m = readMandate(recorded.mandates['M-001']!);
    expect(treasuryNote(false, m.floor, m.balance, m.limits.decimals)).toBe('minimum $100.00 · spendable $8.58');
  });

  it.each([
    ['balance', '10.5'],
    ['spent_today', '1e6'],
  ] as const)('rejects a non-integer vault %s', (field, bad) => {
    const m = structuredClone(recorded.mandates['M-001']!);
    m.vault[field] = bad;
    expect(() => readMandate(m)).toThrow('Not a base-unit amount');
  });

  it.each(['autonomous_limit', 'hard_cap', 'daily_cap', 'treasury_minimum'] as const)('rejects a non-integer %s', (field) => {
    const m = structuredClone(recorded.mandates['M-001']!);
    m.limits[field] = '8.42';
    expect(() => readMandate(m)).toThrow('Not a base-unit amount');
  });

  it('rejects a non-integer decimals before money() can throw', () => {
    const m = structuredClone(recorded.mandates['M-001']!);
    m.limits.decimals = 6.5;
    expect(() => readMandate(m)).toThrow('Bad decimals');
  });
});

describe('mandate page wiring', () => {
  const view = readFileSync(join(root, 'components/mandate-view.tsx'), 'utf8');
  const page = readFileSync(join(root, 'app/mandate/[id]/page.tsx'), 'utf8');

  it('checks amounts in the loader, so a bad payload is the error alert', () => {
    expect(view).toMatch(/getMandate\(id\)\.then\(readMandate\)/);
    expect(view).not.toMatch(/\bBigInt\s*\(/);
    expect(view).toMatch(/treasuryNote\(revoked, floor, balance, d\)/);
  });

  it('remounts MandateView when the route id changes', () => {
    expect(page).toMatch(/<MandateView key=\{id\} id=\{decodeURIComponent\(id\)\} \/>/);
  });
});
