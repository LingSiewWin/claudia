import { bytesToHex, publicKeyFromSecret } from '@authority/core';
import { type UTxO, serializeData } from '@meshsdk/core';
import { describe, expect, it } from 'vitest';
import { FIXED_BUDGET, type TxPlan, buildTx } from '../src/build';
import { type Evaluation, evaluateTx } from '../src/chain';
import { ZERO_VAULT_DATUM } from '../src/data';
import { PREPROD_USDM, anchorDatumFor, mandateAt } from '../src/deployment';
import { ATTACKS, labRecord, labRelease, planFakeVaultUtxo, planForgedAnchor, rejectedBy } from '../src/lab';
import { planWithdraw, releasePlan } from '../src/txs';
import { APPROVER_PKH, ATTACKER_SK, NOW, PRINCIPAL_PKH, type World, world } from './world';

// Attack txs are built exactly as the lab runner submits them: fixed budget, never evaluated by the builder.
const attempt = async (w: World, plan: TxPlan): Promise<Evaluation> => evaluateTx(w.env, await buildTx(w.env, plan, FIXED_BUDGET));
const DAY = BigInt(Math.floor((NOW - 60_000) / 86_400_000));

/** The UTxO the chain would create from a fixture plan's first output (plus its minimum ADA). */
function created(w: World, plan: TxPlan, txHash: string): UTxO {
  const o = plan.outputs[0];
  if (!o) throw new Error('fixture plan has no output');
  const output: UTxO['output'] = { address: o.address, amount: [{ unit: 'lovelace', quantity: '2000000' }, ...o.amount] };
  if (o.datum) output.plutusData = serializeData(o.datum, 'JSON');
  const utxo: UTxO = { input: { txHash, outputIndex: 0 }, output };
  w.add(utxo);
  return utxo;
}

describe('every attack fails in the script check that must stop it', () => {
  const single = [
    'recipient_swap', 'amount_swap', 'expired', 'cfo_bypass', 'hard_cap', 'wrong_asset', 'datum_reset', 'skim',
    'withdraw_without_principal', 'second_anchor_mint', 'second_vault_mint', 'unauthorized_update',
  ] as const;
  for (const id of single) {
    it(id, async () => {
      const w = world();
      const a = ATTACKS[id](w.lab());
      expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
    });
  }

  it('floor, after the principal resets the vault to 1.50', async () => {
    const w = world();
    w.setVault(ZERO_VAULT_DATUM, 1_500_000n);
    const a = ATTACKS.floor(w.lab());
    expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
  });

  it('cross_vault and cross_mandate', async () => {
    const lab = world();
    const m001 = world('b', 'M-001');
    const a = ATTACKS.cross_vault(lab.lab(), m001.deployment.vault.hash);
    expect(rejectedBy(await attempt(lab, a.plan), a.trace)).toBe(true);
    m001.add(...lab.executor.utxos);
    const b = ATTACKS.cross_mandate(lab.lab(), m001.lab());
    expect(rejectedBy(await attempt(m001, b.plan), b.trace)).toBe(true);
  });

  it('fake_vault_utxo and second_vault_input; the principal can still recover the junk', async () => {
    const w = world();
    const fake = created(w, planFakeVaultUtxo(w.lab(), w.principal), 'f0'.repeat(32));
    const a = ATTACKS.fake_vault_utxo(w.lab(), fake);
    expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
    const b = ATTACKS.second_vault_input(w.lab(), fake);
    expect(b.cosigner).toBe('principal');
    expect(rejectedBy(await attempt(w, b.plan), b.trace)).toBe(true);
    const recover = await evaluateTx(w.env, await buildTx(w.env, planWithdraw(w.deployment, w.anchor, [fake], w.refScript, w.principal, null)));
    expect(recover.ok).toBe(true);
  });

  it('fake_anchor: forged datum with the attacker key at the anchor address', async () => {
    const w = world();
    const forged = created(w, planForgedAnchor(w.lab(), bytesToHex(publicKeyFromSecret(ATTACKER_SK)), w.executor), 'f2'.repeat(32));
    const a = ATTACKS.fake_anchor(w.lab(), forged, ATTACKER_SK);
    expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
  });
});

describe('the admin key and the payment approver key cannot stand in for each other', () => {
  it('the approver key alone cannot PrincipalWithdraw, Update or Revoke', async () => {
    for (const id of ['approver_withdraw', 'approver_update', 'approver_revoke'] as const) {
      const w = world();
      const a = ATTACKS[id](w.lab());
      expect([a.plan.requiredSigners, a.cosigner]).toEqual([[APPROVER_PKH], 'approver']);
      expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
    }
  });

  it('the admin signature alone does not satisfy R11', async () => {
    const w = world();
    const a = ATTACKS.principal_cosign(w.lab());
    expect([a.plan.requiredSigners, a.cosigner]).toEqual([[PRINCIPAL_PKH], 'principal']);
    expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
  });

  it('a second MANDATE or VAULT mint requires the principal cosigner', async () => {
    for (const id of ['second_anchor_mint', 'second_vault_mint'] as const) {
      const w = world();
      const a = ATTACKS[id](w.lab());
      expect([a.plan.requiredSigners, a.cosigner]).toEqual([[PRINCIPAL_PKH], 'principal']);
      expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
    }
  });
});

describe('stale authorizations die once the chain moves', () => {
  it('R8: the settled record again, and a lower nonce after a higher one settled', async () => {
    const w = world();
    const first = labRecord(w.lab());
    const lower = labRecord(w.lab(), { nonce: '2' });
    w.setVault({ last_nonce: 3n, day_index: DAY, spent_today: 1_000_000n }, 9_000_000n);
    for (const r of [first, lower]) {
      const a = ATTACKS.replay(w.lab(), r);
      expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
    }
  });

  it('R4 after an Update, R3 after a Revoke', async () => {
    const w = world();
    const v1 = labRecord(w.lab());
    w.setAnchor(anchorDatumFor(mandateAt(w.deployment, 2), PREPROD_USDM));
    const a = ATTACKS.old_version(w.lab(), v1);
    expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
    const v2 = labRecord(w.lab());
    w.setAnchor({ ...w.anchor.datum, status: 'revoked', version: 3 });
    const b = ATTACKS.revoked(w.lab(), v2);
    expect(rejectedBy(await attempt(w, b.plan), b.trace)).toBe(true);
  });

  it('R12: 0.90 once 5.00 is spent today', async () => {
    const w = world();
    w.setVault({ last_nonce: 6n, day_index: DAY, spent_today: 5_000_000n }, 5_000_000n);
    const a = ATTACKS.daily_cap(w.lab());
    expect(rejectedBy(await attempt(w, a.plan), a.trace)).toBe(true);
    w.setVault({ last_nonce: 6n, day_index: DAY, spent_today: 4_100_000n }, 5_900_000n);
    expect(() => ATTACKS.daily_cap(w.lab())).toThrow(/within 0.90/);
  });

  it('R15: an authorization issued at a healthy balance, after the balance dropped', async () => {
    const w = world();
    const r = labRecord(w.lab(), { amount: '1000000' });
    w.setVault(ZERO_VAULT_DATUM, 1_500_000n);
    expect(rejectedBy(await attempt(w, releasePlan(labRelease(w.lab(), r))), 'r15 ? False')).toBe(true);
  });
});
