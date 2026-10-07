// Attack Lab (M-LAB only). Nothing here may read the M-001 engine key: keys arrive as arguments and the
// lab runner reads only M_LAB_* names (test/isolation.test.ts).
import {
  type AuthorizationRecord,
  type AuthorizationRecordFields,
  authorizationDigest,
  bytesToHex,
  encodeAuthorization,
  fieldsFromRecord,
  publicKeyFromSecret,
  signBytes,
} from '@authority/core';
import type { UTxO } from '@meshsdk/core';
import { MANDATE_TOKEN, VAULT_TOKEN } from './blueprint';
import type { TxPlan, Wallet } from './build';
import { type Evaluation, slotAt } from './chain';
import { MINT_REDEEMER, PRINCIPAL_WITHDRAW, ZERO_VAULT_DATUM, anchorDatumData, vaultDatumData } from './data';
import { type Deployment, scriptsOf } from './deployment';
import type { AnchorState, VaultState } from './state';
import {
  RECIPIENT_OUT,
  type ReleaseInput,
  UPPER_OFFSET_MS,
  VAULT_OUT,
  emptyPlan,
  planAnchorRevoke,
  planAnchorUpdate,
  planWithdraw,
  releasePlan,
  shift,
} from './txs';

/**
 * Signs exactly the fields it is given with the lab engine key, bypassing the issuance gate: the
 * compromised-engine model of the Attack Lab, where the vault is the only guard left.
 */
export function signWithEngineKey(fields: AuthorizationRecordFields, engineSecretKey: Uint8Array): AuthorizationRecord {
  const typed = fieldsFromRecord({ fields } as AuthorizationRecord);
  const digest = authorizationDigest(typed);
  return {
    schema: 'authorization/v0.1',
    message_hex: bytesToHex(encodeAuthorization(typed)),
    digest_hex: bytesToHex(digest),
    signature_hex: bytesToHex(signBytes(digest, engineSecretKey)),
    engine_public_key: bytesToHex(publicKeyFromSecret(engineSecretKey)),
    fields,
  };
}

export interface LabContext {
  deployment: Deployment;
  anchor: AnchorState;
  vault: VaultState;
  refScript: UTxO;
  /** The executor's fee wallet; also the attacker's payout address in recipient swaps. */
  executor: Wallet;
  engineSecretKey: Uint8Array;
  /** AWS (demo vendor) payout address. */
  payee: string;
  actionHash: string;
  nowMs: number;
}

/** A lab authorization: 0.50 USDM to the payee, next nonce, 10-minute expiry, then `overrides`. */
export function labRecord(ctx: LabContext, overrides: Partial<AuthorizationRecordFields> = {}): AuthorizationRecord {
  const a = ctx.anchor.datum;
  return signWithEngineKey(
    {
      chain_tag: 0,
      vault_hash: ctx.deployment.vault.hash,
      mandate_ref: ctx.deployment.anchor.policy,
      mandate_hash: a.mandate_hash,
      mandate_version: a.version,
      action_hash: ctx.actionHash,
      action_type: 1,
      asset_policy: a.asset_policy,
      asset_name: a.asset_name,
      amount: '500000',
      recipient: ctx.payee,
      nonce: (ctx.vault.datum.last_nonce + 1n).toString(),
      valid_until: Math.min(ctx.nowMs + 600_000, Number(a.valid_until)),
      requires_principal: false,
      verification_ref: null,
      ...overrides,
    },
    ctx.engineSecretKey,
  );
}

export const labRelease = (ctx: LabContext, record: AuthorizationRecord): ReleaseInput => ({
  deployment: ctx.deployment,
  anchor: ctx.anchor,
  vault: ctx.vault,
  refScript: ctx.refScript,
  record,
  wallet: ctx.executor,
  nowMs: ctx.nowMs,
  mandateLabel: `${ctx.deployment.mandate_id}@${ctx.anchor.datum.version}`,
  logHead: null,
});

export interface Attack {
  /** The vault or anchor check that must reject it, as the script traces it. */
  trace: string;
  plan: TxPlan;
  /** Key that signs besides the executor, so the node refuses in phase 2 and not for a missing witness. */
  cosigner: 'principal' | 'approver' | null;
}

const release = (ctx: LabContext, overrides: Partial<AuthorizationRecordFields> = {}) => releasePlan(labRelease(ctx, labRecord(ctx, overrides)));

/** 0.90 USDM, the amount the R12 attack tries to add once today's spend is already against the cap. */
const DAILY_CAP_ATTACK = 900_000n;

/** True when one more 0.90 would exceed today's cap. That is the only state `ATTACKS.daily_cap` can run in. */
export function dailyCapPrimed(ctx: LabContext): boolean {
  return ctx.vault.datum.spent_today + DAILY_CAP_ATTACK > ctx.anchor.datum.daily_cap;
}

/** Single-transaction attacks against the M-LAB vault and anchor. Each must fail with `trace`. */
export const ATTACKS = {
  /** R8: an authorization whose nonce is no longer above the vault's (it settled, or a higher one did). */
  replay: (ctx: LabContext, issued: AuthorizationRecord): Attack => ({ trace: 'r8 ? False', plan: releasePlan(labRelease(ctx, issued)), cosigner: null }),
  /** R4: an authorization issued under the previous anchor version. */
  old_version: (ctx: LabContext, issued: AuthorizationRecord): Attack => ({ trace: 'r4 ? False', plan: releasePlan(labRelease(ctx, issued)), cosigner: null }),
  /** R3: an authorization submitted after the principal revoked the anchor. */
  revoked: (ctx: LabContext, issued: AuthorizationRecord): Attack => ({ trace: 'r3 ? False', plan: releasePlan(labRelease(ctx, issued)), cosigner: null }),
  /** R12 (stolen engine key): one more 0.90 once today's spend leaves less than 0.90 under the cap. */
  daily_cap: (ctx: LabContext): Attack => {
    if (!dailyCapPrimed(ctx)) throw new Error('daily cap attack needs today\'s spend within 0.90 of the cap');
    return { trace: 'r12 ? False', plan: release(ctx, { amount: DAILY_CAP_ATTACK.toString() }), cosigner: null };
  },
  /** R16: valid authorization to AWS; the tx pays the executor instead. */
  recipient_swap: (ctx: LabContext): Attack => {
    const plan = release(ctx);
    (plan.outputs[RECIPIENT_OUT] as { address: string }).address = ctx.executor.address;
    return { trace: 'r16 ? False', plan, cosigner: null };
  },
  /** R6: valid 0.50 authorization; the redeemer amount is edited to 5.00 (signature unchanged). */
  amount_swap: (ctx: LabContext): Attack => {
    const r = labRecord(ctx);
    const forged = { ...r, fields: { ...r.fields, amount: '5000000' } };
    return { trace: 'r6 ? False', plan: releasePlan(labRelease(ctx, forged)), cosigner: null };
  },
  /** R7: the authorization expired a minute ago; the executor submits anyway with a later upper bound. */
  expired: (ctx: LabContext): Attack => {
    const plan = release(ctx, { valid_until: ctx.nowMs - 60_000 });
    plan.validity = { lowerSlot: slotAt(ctx.nowMs - 60_000), upperSlot: slotAt(ctx.nowMs + UPPER_OFFSET_MS) };
    return { trace: 'r7 ? False', plan, cosigner: null };
  },
  /** R11 (stolen engine key): 1.80 above the 1.00 autonomous limit, unflagged, no approver signature. */
  cfo_bypass: (ctx: LabContext): Attack => ({ trace: 'r11 ? False', plan: release(ctx, { amount: '1800000' }), cosigner: null }),
  /** R11 (key split): a flagged 1.80 co-signed by the admin key instead of the payment approver. */
  principal_cosign: (ctx: LabContext): Attack => {
    const plan = release(ctx, { amount: '1800000', requires_principal: true });
    plan.requiredSigners = [ctx.anchor.datum.principal_pkh];
    return { trace: 'r11 ? False', plan, cosigner: 'principal' };
  },
  /** R10 (stolen engine key): 6.00 above the 5.00 hard cap. */
  hard_cap: (ctx: LabContext): Attack => ({ trace: 'r10 ? False', plan: release(ctx, { amount: '6000000' }), cosigner: null }),
  /** R9 (stolen engine key): an authorization for another asset. */
  wrong_asset: (ctx: LabContext): Attack => ({ trace: 'r9 ? False', plan: release(ctx, { asset_policy: 'ab'.repeat(28) }), cosigner: null }),
  /** R13: the executor resets the continuing datum to zero. */
  datum_reset: (ctx: LabContext): Attack => {
    const plan = release(ctx);
    (plan.outputs[VAULT_OUT] as { datum: unknown }).datum = vaultDatumData(ZERO_VAULT_DATUM);
    return { trace: 'r13 ? False', plan, cosigner: null };
  },
  /** R14: the executor skims 1 ADA from the continuing output. */
  skim: (ctx: LabContext): Attack => {
    const plan = release(ctx);
    const out = plan.outputs[VAULT_OUT] as { amount: TxPlan['outputs'][number]['amount'] };
    out.amount = shift(out.amount, 'lovelace', -1_000_000n);
    return { trace: 'r14 ? False', plan, cosigner: null };
  },
  /** R15 (stolen engine key): 1.00 that takes the vault below its 1.00 floor. Needs balance < 2.00. */
  floor: (ctx: LabContext): Attack => {
    const amount = ctx.anchor.datum.autonomous_limit;
    if (ctx.vault.balance - amount >= ctx.anchor.datum.treasury_minimum) throw new Error('floor attack needs the vault below floor + 1.00; reset it first');
    return { trace: 'r15 ? False', plan: release(ctx, { amount: amount.toString() }), cosigner: null };
  },
  /** W1: the executor spends the vault with PrincipalWithdraw without the principal. */
  withdraw_without_principal: (ctx: LabContext): Attack => {
    const plan = planWithdraw(ctx.deployment, ctx.anchor, [ctx.vault.utxo], ctx.refScript, ctx.executor, null);
    plan.requiredSigners = [];
    return { trace: 'w1 ? False', plan, cosigner: null };
  },
  /** W1 (key split): the payment approver's key alone tries PrincipalWithdraw. */
  approver_withdraw: (ctx: LabContext): Attack => {
    const plan = planWithdraw(ctx.deployment, ctx.anchor, [ctx.vault.utxo], ctx.refScript, ctx.executor, null);
    plan.requiredSigners = [ctx.anchor.datum.approver_pkh];
    return { trace: 'w1 ? False', plan, cosigner: 'approver' };
  },
  /** M1: a second MANDATE mint under the anchor policy (its seed is long spent). */
  second_anchor_mint: (ctx: LabContext): Attack => {
    const { anchor } = scriptsOf(ctx.deployment);
    const plan = emptyPlan(ctx.executor);
    plan.mints = [{ policy: anchor.hash, name: MANDATE_TOKEN, quantity: 1n, script: anchor.cbor, redeemer: MINT_REDEEMER }];
    plan.outputs = [{ address: anchor.address, amount: [{ unit: anchor.hash + MANDATE_TOKEN, quantity: '1' }], datum: anchorDatumData(ctx.anchor.datum) }];
    plan.requiredSigners = [ctx.anchor.datum.principal_pkh];
    return { trace: 'm1 ? False', plan, cosigner: null };
  },
  /** V1: a second VAULT mint under the vault policy (its seed is long spent). */
  second_vault_mint: (ctx: LabContext): Attack => {
    const { vault } = scriptsOf(ctx.deployment);
    const plan = emptyPlan(ctx.executor);
    plan.referenceInputs = [ctx.anchor.utxo];
    plan.mints = [{ policy: vault.hash, name: VAULT_TOKEN, quantity: 1n, script: vault.cbor, redeemer: MINT_REDEEMER }];
    plan.outputs = [{ address: vault.address, amount: [{ unit: vault.hash + VAULT_TOKEN, quantity: '1' }], datum: vaultDatumData(ZERO_VAULT_DATUM) }];
    plan.requiredSigners = [ctx.anchor.datum.principal_pkh];
    return { trace: 'v1 ? False', plan, cosigner: null };
  },
  /** R5: an M-LAB authorization naming another vault (the M-001 vault hash), spent against M-LAB. */
  cross_vault: (ctx: LabContext, otherVaultHash: string): Attack => ({
    trace: 'r5 ? False',
    plan: release(ctx, { vault_hash: otherVaultHash }),
    cosigner: null,
  }),
  /** R4: an M-LAB authorization spent against the M-001 vault, whose anchor is another mandate. */
  cross_mandate: (ctx: LabContext, m001: Pick<LabContext, 'deployment' | 'anchor' | 'vault' | 'refScript'>): Attack => ({
    trace: 'r4 ? False',
    plan: releasePlan({
      ...labRelease(ctx, labRecord(ctx)),
      deployment: m001.deployment,
      anchor: m001.anchor,
      vault: m001.vault,
      refScript: m001.refScript,
    }),
    cosigner: null,
  }),
  /** R0: a release that spends an attacker-made UTxO at the vault address (no VAULT token). */
  fake_vault_utxo: (ctx: LabContext, fake: UTxO): Attack => {
    const fakeCtx = { ...ctx, vault: { utxo: fake, datum: ZERO_VAULT_DATUM, balance: quantity(fake, ctx) } };
    return { trace: 'r0 ? False', plan: release(fakeCtx), cosigner: null };
  },
  /** R1: a release plus a second vault-address input (the junk UTxO, spent by the principal). */
  second_vault_input: (ctx: LabContext, junk: UTxO): Attack => {
    const plan = release(ctx);
    const first = plan.scriptInputs[0];
    if (!first) throw new Error('release plan has no vault input');
    plan.scriptInputs.push({ ...first, utxo: junk, redeemer: PRINCIPAL_WITHDRAW });
    plan.requiredSigners.push(ctx.anchor.datum.principal_pkh);
    return { trace: 'r1 ? False', plan, cosigner: 'principal' };
  },
  /** R2: an authorization signed by the attacker's key, against a forged anchor UTxO (no MANDATE NFT). */
  fake_anchor: (ctx: LabContext, forged: UTxO, attackerSecretKey: Uint8Array): Attack => {
    const plan = releasePlan(labRelease(ctx, labRecord({ ...ctx, engineSecretKey: attackerSecretKey })));
    plan.referenceInputs = [forged];
    return { trace: 'r2 ? need exactly one anchor reference input', plan, cosigner: null };
  },
  /** U1 (stolen engine key or executor): raise the hard cap without the principal. */
  unauthorized_update: (ctx: LabContext): Attack => {
    const next = { ...ctx.anchor.datum, version: ctx.anchor.datum.version + 1, hard_cap: ctx.anchor.datum.hard_cap * 10n };
    const plan = planAnchorUpdate(ctx.deployment, ctx.anchor, next, ctx.executor);
    plan.requiredSigners = [];
    return { trace: 'update_signed ? False', plan, cosigner: null };
  },
  /** U1 (key split): the payment approver's key alone tries to raise the hard cap. */
  approver_update: (ctx: LabContext): Attack => {
    const next = { ...ctx.anchor.datum, version: ctx.anchor.datum.version + 1, hard_cap: ctx.anchor.datum.hard_cap * 10n };
    const plan = planAnchorUpdate(ctx.deployment, ctx.anchor, next, ctx.executor);
    plan.requiredSigners = [ctx.anchor.datum.approver_pkh];
    return { trace: 'update_signed ? False', plan, cosigner: 'approver' };
  },
  /** Revoke (key split): the payment approver's key alone tries to revoke the anchor. */
  approver_revoke: (ctx: LabContext): Attack => {
    const plan = planAnchorRevoke(ctx.deployment, ctx.anchor, ctx.executor);
    plan.requiredSigners = [ctx.anchor.datum.approver_pkh];
    return { trace: 'revoke_signed ? False', plan, cosigner: 'approver' };
  },
} as const;

export type AttackId = keyof typeof ATTACKS;

/** True when evaluation failed and the failing script reported `trace`. */
export const rejectedBy = (e: Evaluation, trace: string): boolean => !e.ok && [...e.logs, e.message].some((line) => line.includes(trace));

const quantity = (u: UTxO, ctx: LabContext) =>
  BigInt(u.output.amount.find((a) => a.unit === ctx.deployment.asset.policy + ctx.deployment.asset.name)?.quantity ?? '0');

/** Fixture for R0 and R1: anyone can pay a UTxO to the vault address; it carries 1.00 USDM and a zero datum. */
export function planFakeVaultUtxo(ctx: LabContext, funder: Wallet): TxPlan {
  const plan = emptyPlan(funder);
  const unit = ctx.deployment.asset.policy + ctx.deployment.asset.name;
  plan.outputs = [{ address: ctx.deployment.vault.address, amount: [{ unit, quantity: '1000000' }], datum: vaultDatumData(ZERO_VAULT_DATUM) }];
  return plan;
}

/** Fixture for R2: a UTxO at the anchor address whose datum names the attacker's engine key and a 50.00 hard cap. */
export function planForgedAnchor(ctx: LabContext, attackerVkey: string, funder: Wallet): TxPlan {
  const plan = emptyPlan(funder);
  const datum = { ...ctx.anchor.datum, engine_vkey: attackerVkey, hard_cap: ctx.anchor.datum.hard_cap * 10n };
  plan.outputs = [{ address: ctx.deployment.anchor.address, amount: [], datum: anchorDatumData(datum) }];
  return plan;
}
