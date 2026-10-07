import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const page = readFileSync(new URL('app/page.tsx', root), 'utf8');
const section = readFileSync(new URL('components/built-with.tsx', root), 'utf8');

describe('built with', () => {
  it('is the last section of the home page, names the integrations in a marquee and four described rows, and ships both logo files', () => {
    expect(page.lastIndexOf('<BuiltWith />')).toBeGreaterThan(page.lastIndexOf('<AudienceScroll'));
    for (const name of ['Cardano', 'Chainlink', 'Masumi', 'Sokosumi', 'x402']) expect(section).toContain(`name: '${name}'`);
    for (const name of ['Cardano', 'Chainlink', 'Masumi and Sokosumi', 'x402']) expect(section).toContain(`name: '${name}'`);
    expect(section).not.toMatch(/Supported by|Powered by/);
    for (const file of ['cardano.svg', 'cardano.png', 'chainlink.svg', 'chainlink.png']) {
      expect(existsSync(new URL(`public/logos/${file}`, root)), file).toBe(true);
    }
  });
});
