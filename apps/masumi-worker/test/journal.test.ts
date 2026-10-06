import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Journal, LEASE_TTL_MS, holdGeneration, tryAcquireLease } from '../src/journal';

const crash = vi.hoisted(() => ({ beforeRename: false, reenter: null as null | (() => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const runHook = () => {
    const fn = crash.reenter;
    crash.reenter = null;
    fn?.();
  };
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (crash.beforeRename) throw new Error('simulated crash before rename');
      runHook();
      fs.renameSync(from, to);
    },
    linkSync: (from: string, to: string) => {
      runHook();
      fs.linkSync(from, to);
    },
  };
});

const dir = (): string => mkdtempSync(join(tmpdir(), 'masumi-worker-'));

describe('Journal', () => {
  it('round-trips records and lists keys without temp files', () => {
    const d = dir();
    const j = new Journal<{ stage: string }>(d);
    expect(j.read('aabbccddeeff00112233')).toBeNull();
    j.write('aabbccddeeff00112233', { stage: 'quote-pending' });
    j.write('aabbccddeeff00112233', { stage: 'awaiting-payment' });
    expect(j.read('aabbccddeeff00112233')).toEqual({ stage: 'awaiting-payment' });
    expect(new Journal<{ stage: string }>(d).keys()).toEqual(['aabbccddeeff00112233']);
    expect(readdirSync(d).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it.each(['../escape', 'a/b', '', 'x'.repeat(129)])('rejects unsafe key %j', (key) => {
    expect(() => new Journal(dir()).write(key, {})).toThrow(/unsafe/);
  });

  it('stores keys in lowercase', () => {
    const d = dir();
    const j = new Journal<{ stage: string }>(d);
    j.write('AABBCCDDEEFF00112233', { stage: 'quote-pending' });
    expect(j.read('aabbccddeeff00112233')).toEqual({ stage: 'quote-pending' });
    expect(j.read('AaBbCcDdEeFf00112233')).toEqual({ stage: 'quote-pending' });
    expect(j.keys()).toEqual(['aabbccddeeff00112233']);
  });

  it('a crash before the rename keeps the previous record after restart', () => {
    const d = dir();
    new Journal<{ stage: string }>(d).write('aabbccddeeff00112233', { stage: 'quote-pending' });
    crash.beforeRename = true;
    try {
      expect(() =>
        new Journal<{ stage: string }>(d).write('aabbccddeeff00112233', { stage: 'awaiting-payment' }),
      ).toThrow(/simulated crash/);
    } finally {
      crash.beforeRename = false;
    }
    const restarted = new Journal<{ stage: string }>(d);
    expect(restarted.read('aabbccddeeff00112233')).toEqual({ stage: 'quote-pending' });
    expect(restarted.keys()).toEqual(['aabbccddeeff00112233']);
  });

  it('a crash during the first write leaves no record and no listed key', () => {
    const d = dir();
    crash.beforeRename = true;
    try {
      expect(() => new Journal<{ stage: string }>(d).write('aabbccddeeff00112233', { stage: 'quote-pending' })).toThrow(
        /simulated crash/,
      );
    } finally {
      crash.beforeRename = false;
    }
    expect(readdirSync(d).some((f) => f.endsWith('.tmp'))).toBe(true);
    const restarted = new Journal<{ stage: string }>(d);
    expect(restarted.read('aabbccddeeff00112233')).toBeNull();
    expect(restarted.keys()).toEqual([]);
  });
});

describe('lease', () => {
  it('one executor at a time; takeover only after the TTL', () => {
    const d = dir();
    expect(tryAcquireLease(d, 'a', 1_000)).toBe(true);
    expect(tryAcquireLease(d, 'b', 1_000 + LEASE_TTL_MS - 1)).toBe(false);
    expect(tryAcquireLease(d, 'a', 1_000 + LEASE_TTL_MS - 1)).toBe(true); // renew
    expect(tryAcquireLease(d, 'b', 1_000 + 2 * LEASE_TTL_MS - 2)).toBe(false);
    expect(tryAcquireLease(d, 'b', 1_000 + 2 * LEASE_TTL_MS)).toBe(true);
    expect(tryAcquireLease(d, 'a', 1_000 + 2 * LEASE_TTL_MS + 1)).toBe(false);
  });

  it('two concurrent acquires yield exactly one winner', () => {
    const d = dir();
    const outcomes: boolean[] = [];
    crash.reenter = () => {
      outcomes.push(tryAcquireLease(d, 'b', 1_000));
    };
    outcomes.push(tryAcquireLease(d, 'a', 1_000));
    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((won) => won)).toHaveLength(1);
  });

  it('generation mismatches after an expiry takeover', () => {
    const d = dir();
    expect(tryAcquireLease(d, 'a', 1_000)).toBe(true);
    const generation = holdGeneration(d);
    expect(generation).toEqual(expect.any(String));
    expect(generation!.length).toBeGreaterThan(0);
    expect(tryAcquireLease(d, 'a', 2_000)).toBe(true);
    expect(holdGeneration(d)).toBe(generation);
    expect(tryAcquireLease(d, 'b', 2_000 + LEASE_TTL_MS)).toBe(true);
    expect(holdGeneration(d)).not.toBe(generation);
    expect(holdGeneration(d)).toEqual(expect.any(String));
  });

  it.each(['{}', '{"owner":"x"}', '{"owner":"x","renewedAt":"1"}', '{"owner":"","renewedAt":1}'])(
    'malformed lease %s is not taken over',
    (body) => {
      const d = dir();
      writeFileSync(join(d, 'lease.json'), body);
      expect(tryAcquireLease(d, 'a', 1_000)).toBe(false);
      expect(holdGeneration(d)).toBeNull();
    },
  );
});
