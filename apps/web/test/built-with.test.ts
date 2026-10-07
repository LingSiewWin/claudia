import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const page = readFileSync(new URL('app/page.tsx', root), 'utf8');

describe('built with', () => {
  it('names the four integrations in the last section and ships both logo files', () => {
    const section = page.slice(page.indexOf('aria-label="Built with"'), page.indexOf('<SiteFooter />'));
    expect(section.length).toBeGreaterThan(0);
    for (const name of ['Cardano', 'Chainlink', 'Masumi and Sokosumi', 'x402']) expect(section).toContain(`name="${name}"`);
    expect(section).not.toMatch(/Supported by|Powered by/);
    for (const file of ['cardano.svg', 'cardano.png', 'chainlink.svg', 'chainlink.png']) {
      expect(existsSync(new URL(`public/logos/${file}`, root)), file).toBe(true);
    }
  });
});
