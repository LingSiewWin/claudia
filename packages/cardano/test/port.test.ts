import { readFileSync } from 'node:fs';
import { serializeData } from '@meshsdk/core';
import { describe, expect, it } from 'vitest';
import { FIXED_BUDGET, buildTx } from '../src/build';
import { evaluateTx } from '../src/chain';
import { digestDatum, releaseRedeemer } from '../src/data';
import { ATTACKS, labRecord, labRelease, rejectedBy } from '../src/lab';
import {
  CardanoError,
  createCardanoPort,
  createLabRunner,
  evaluationFailure,
  findConfirmedRelease,
  prepareLabAttack,
  runPrepared,
} from '../src/port';
import { DAY_MS, planAnchorRevoke, planRelease } from '../src/txs';
import { NOW, world } from './world';

const CARDANO_METHODS = [
  'awaitConfirmation',
  'buildAnchorRevoke',
  'buildAnchorUpdate',
  'buildRelease',
  'readAnchor',
  'readVaultState',
  'releaseOf',
  'bondAddresses',
  'readBond',
  'buildBondSpend',
  'submitSigned',
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

  it('does not authorize an open invoice for replay or revoked', () => {
    const source = readFileSync(new URL('../src/port.ts', import.meta.url), 'utf8');
    const runner = source.slice(source.indexOf('export function createLabRunner'));
    expect(runner).toContain('prepareLabAttack');
    expect(runner).toContain('runPrepared');
    expect(runner).not.toContain('ctx.authorize');
    expect(runner).not.toContain('ctx.forge');
    expect(runner).not.toContain('M_LAB_INVOICE_NUMBER');
  });
});

const DAY = BigInt(Math.floor((NOW - 60_000) / DAY_MS));

describe('replay and revoked do not submit a fresh release', () => {
  it('replay uses a nonce that is already <= last_nonce, and that release is rejected', async () => {
    const w = world();
    w.setVault({ last_nonce: 4n, day_index: DAY, spent_today: 0n }, 10_000_000n);
    const lab = w.lab();
    expect(BigInt(labRecord(lab).fields.nonce)).toBe(5n);
    const prepared = prepareLabAttack('replay', lab);
    expect(prepared.kind).toBe('attack');
    if (prepared.kind !== 'attack' || !prepared.record) throw new Error('replay did not keep its record');
    expect(BigInt(prepared.record.fields.nonce) <= lab.vault.datum.last_nonce).toBe(true);
    expect(prepared.attack.plan.scriptInputs[0]?.redeemer).toEqual(releaseRedeemer(prepared.record));
    expect(rejectedBy(await evaluateTx(w.env, await buildTx(w.env, prepared.attack.plan, FIXED_BUDGET)), 'r8 ? False')).toBe(true);
    let submitted = 0;
    await runPrepared(prepared, {
      revoke: async () => {
        throw new Error('replay must not revoke');
      },
      submit: async (attack) => {
        submitted += 1;
        expect(attack).toBe(prepared.attack);
        return { code: 'R8', tx_hash: null, funds_moved: '0', outcome: 'submitted' };
      },
    });
    expect(submitted).toBe(1);
  });

  it('revoked revokes first and submits the pre-revoke record only after the anchor is revoked', async () => {
    const w = world();
    const lab = w.lab();
    const prepared = prepareLabAttack('revoked', lab);
    expect(prepared.kind).toBe('revoke_then_attack');
    if (prepared.kind !== 'revoke_then_attack') throw new Error('revoked did not plan a revoke');
    expect(prepared.revoke).toEqual(planAnchorRevoke(lab.deployment, lab.anchor, lab.executor));
    expect(prepared.revoke.scriptInputs[0]?.redeemer).not.toEqual(ATTACKS.revoked(lab, prepared.record).plan.scriptInputs[0]?.redeemer);
    expect(BigInt(prepared.record.fields.nonce)).toBe(lab.vault.datum.last_nonce + 1n);
    expect(prepared.record.fields.mandate_version).toBe(lab.anchor.datum.version);
    expect((await evaluateTx(w.env, await buildTx(w.env, planRelease(labRelease(lab, prepared.record))))).ok).toBe(true);

    const whileActive: string[] = [];
    await expect(
      runPrepared(prepared, {
        async revoke() {
          whileActive.push('revoke');
          return lab;
        },
        async submit() {
          whileActive.push('submit');
          throw new Error('submitted the pre-revoke record');
        },
      }),
    ).rejects.toThrow(/not submitted/);
    expect(whileActive).toEqual(['revoke']);

    await expect(
      runPrepared(prepared, {
        revoke: async () => {
          throw new Error('revoke rejected');
        },
        submit: async () => {
          throw new Error('submitted the pre-revoke record');
        },
      }),
    ).rejects.toThrow(/revoke rejected/);

    const version = lab.anchor.datum.version;
    const submitted: string[] = [];
    await runPrepared(prepared, {
      async revoke(plan) {
        submitted.push('revoke');
        expect(plan).toBe(prepared.revoke);
        w.setAnchor({ ...w.anchor.datum, status: 'revoked', version: version + 1 });
        return w.lab();
      },
      async submit(attack) {
        submitted.push('attack');
        expect(attack.trace).toBe('r3 ? False');
        expect(attack.plan.scriptInputs[0]?.redeemer).toEqual(releaseRedeemer(prepared.record));
        expect(rejectedBy(await evaluateTx(w.env, await buildTx(w.env, attack.plan, FIXED_BUDGET)), 'r3 ? False')).toBe(true);
        return { code: 'R3', tx_hash: 'ab'.repeat(32), funds_moved: '0', outcome: 'submitted' };
      },
    });
    expect(submitted).toEqual(['revoke', 'attack']);
  });

  it('daily_cap returns not primed until spent_today can trip the cap, and that result is not a submission', async () => {
    const w = world();
    const cold = prepareLabAttack('daily_cap', w.lab());
    expect(cold).toEqual({ kind: 'not_primed', code: 'NOT_PRIMED' });
    let called = false;
    const result = await runPrepared(cold, {
      revoke: async () => {
        throw new Error('daily cap must not revoke');
      },
      submit: async () => {
        called = true;
        throw new Error('daily cap must not submit');
      },
    });
    expect(called).toBe(false);
    expect(result).toEqual({ code: 'NOT_PRIMED', tx_hash: null, funds_moved: '0', outcome: 'not_primed' });
    w.setVault({ last_nonce: 6n, day_index: DAY, spent_today: 5_000_000n }, 5_000_000n);
    expect(prepareLabAttack('daily_cap', w.lab()).kind).toBe('attack');
  });
});

describe('one CardanoError class', () => {
  it('classifies contention on an evaluation failure before forcing SCRIPT_FAILED', () => {
    const contended = evaluationFailure('evaluate failed: BadInputsUTxO', ['r8 ? False'], 'bb'.repeat(2));
    expect(contended).toBeInstanceOf(CardanoError);
    expect(contended.code).toBe('CONTENTION');
    expect(contended.invariant).toBe('R8');
    expect(contended.txCbor).toBe('bbbb');
    const script = evaluationFailure('script failed', ['r12 ? False'], 'cc');
    expect(script.code).toBe('SCRIPT_FAILED');
    expect(script.invariant).toBe('R12');
    const other = evaluationFailure('unit mismatch', [], 'dd');
    expect(other.code).toBe('SCRIPT_FAILED');
    expect(other.invariant).toBeNull();
  });
});

describe('releaseOf fails closed', () => {
  const w = world();
  const record = labRecord(w.lab());
  const recipient = record.fields.recipient;
  const want = serializeData(digestDatum(record), 'JSON');
  const listPath = (page: number) => `/addresses/${encodeURIComponent(recipient)}/transactions?order=desc&count=100&page=${page}`;

  function hashOf(path: string): string {
    return /^\/txs\/([^/]+)\/utxos$/.exec(path)?.[1] ?? '';
  }

  it('returns null for an empty list or a 404, and throws on any other status', async () => {
    await expect(findConfirmedRelease(async () => ({ status: 404, body: null }), async () => false, record)).resolves.toBeNull();
    await expect(findConfirmedRelease(async () => ({ status: 200, body: [] }), async () => false, record)).resolves.toBeNull();
    await expect(findConfirmedRelease(async () => ({ status: 429, body: null }), async () => false, record)).rejects.toThrow(/429/);
    await expect(findConfirmedRelease(async () => ({ status: 500, body: null }), async () => false, record)).rejects.toThrow(/500/);
    await expect(findConfirmedRelease(async () => ({ status: 200, body: { tx_hash: 'nope' } }), async () => false, record)).rejects.toThrow(/transaction list/);
  });

  it('returns a confirmed digest on the first page and does not read a second page', async () => {
    const hit = 'aa'.repeat(32);
    const calls: string[] = [];
    const found = await findConfirmedRelease(
      async (path) => {
        calls.push(path);
        if (path.includes('/utxos')) return { status: 200, body: { outputs: [{ address: recipient, inline_datum: want }] } };
        return { status: 200, body: [{ tx_hash: hit }] };
      },
      async () => true,
      record,
    );
    expect(found).toBe(hit);
    expect(calls).toEqual([listPath(1), `/txs/${hit}/utxos`]);
  });

  it('follows pages until a confirmed hit older than the newest 100 transactions', async () => {
    const older = 'ab'.repeat(32);
    const page1 = Array.from({ length: 100 }, (_, i) => ({ tx_hash: i.toString(16).padStart(64, '1') }));
    const found = await findConfirmedRelease(
      async (path) => {
        if (path.includes('/utxos')) {
          const hash = hashOf(path);
          return { status: 200, body: { outputs: [{ address: recipient, inline_datum: hash === older ? want : null }] } };
        }
        const page = Number(new URL(path, 'https://example.test').searchParams.get('page'));
        if (page === 1) return { status: 200, body: page1 };
        if (page === 2) return { status: 200, body: [{ tx_hash: older }] };
        return { status: 200, body: [] };
      },
      async () => true,
      record,
    );
    expect(found).toBe(older);
  });

  it('throws when a later page or a utxo read fails, and skips an unconfirmed hit', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ tx_hash: i.toString(16).padStart(64, '2') }));
    await expect(
      findConfirmedRelease(
        async (path) => {
          if (path.includes('/utxos')) return { status: 200, body: { outputs: [] } };
          const page = Number(new URL(path, 'https://example.test').searchParams.get('page'));
          if (page === 1) return { status: 200, body: page1 };
          return { status: 500, body: null };
        },
        async () => true,
        record,
      ),
    ).rejects.toThrow(/500/);

    await expect(
      findConfirmedRelease(
        async (path) => {
          if (path.includes('/utxos')) return { status: 429, body: null };
          return { status: 200, body: [{ tx_hash: 'cd'.repeat(32) }] };
        },
        async () => true,
        record,
      ),
    ).rejects.toThrow(/429/);

    const pending = 'de'.repeat(32);
    await expect(
      findConfirmedRelease(
        async (path) => {
          if (path.includes('/utxos')) return { status: 200, body: { outputs: [{ address: recipient, inline_datum: want }] } };
          return { status: 200, body: [{ tx_hash: pending }] };
        },
        async () => false,
        record,
      ),
    ).resolves.toBeNull();
  });
});
