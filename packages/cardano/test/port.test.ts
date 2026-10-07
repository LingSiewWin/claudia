import { describe, expect, it } from 'vitest';
import { createCardanoPort, createLabRunner } from '../src';

const CARDANO_METHODS = [
  'awaitConfirmation',
  'buildAnchorRevoke',
  'buildAnchorUpdate',
  'buildRelease',
  'readAnchor',
  'readVaultState',
  'releaseOf',
  'submit',
] as const;

describe('authority port factories', () => {
  it('exports createCardanoPort and createLabRunner with the CardanoPort and LabRunner methods', () => {
    expect(typeof createCardanoPort).toBe('function');
    expect(typeof createLabRunner).toBe('function');
    const port = createCardanoPort({});
    expect(Object.keys(port).sort()).toEqual([...CARDANO_METHODS].sort());
    for (const name of CARDANO_METHODS) expect(typeof port[name]).toBe('function');
    const runner = createLabRunner({}, port);
    expect(runner).not.toBeNull();
    expect(Object.keys(runner!).sort()).toEqual(['run']);
    expect(typeof runner!.run).toBe('function');
  });
});
