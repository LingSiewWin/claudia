import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixturesModule, vectorsModule } from '../scripts/gen-aiken';

const lib = new URL('../../../contracts/cardano/lib/authority/', import.meta.url);

describe('generated Aiken modules', () => {
  it.each([
    ['vectors.test.ak', vectorsModule],
    ['fixtures.ak', fixturesModule],
  ] as const)('%s is in sync with the TS core', (file, generate) => {
    expect(readFileSync(new URL(file, lib), 'utf8')).toBe(generate());
  });
});
