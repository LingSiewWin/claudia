import { type AuthorizationRecord, parseShelleyAddress, verifyAuthorizationRecord } from '@authority/core';
import type { Asset, UTxO } from '@meshsdk/core';
import { MANDATE_TOKEN, type Script, VAULT_TOKEN, anchorScript, vaultScript } from './blueprint';
import type { PlanOutput, TxPlan, Wallet } from './build';
import { msAt, slotAt } from './chain';
import {
  ANCHOR_REVOKE,
  type AnchorDatum,
  DEPOSIT,
  MINT_REDEEMER,
  PRINCIPAL_WITHDRAW,
  type VaultDatum,
  ZERO_VAULT_DATUM,
  anchorDatumData,
  anchorUpdate,
  digestDatum,
  releaseRedeemer,
  vaultDatumData,
} from './data';
import { type Deployment, assertDeployable } from './deployment';
import type { AnchorState, VaultState } from './state';

export const DAY_MS = 86_400_000;
/** Spec 03 section 5: L = now - 60 s (raised to the vault's day start, see releasePlan), U = min(now + 5 min, auth.valid_until, mandate expiry). */
export const LOWER_OFFSET_MS = 60_000;
export const UPPER_OFFSET_MS = 300_000;
/** Lovelace locked with the VAULT token at creation; leaves room for the datum to grow. */
export const VAULT_LOVELACE = 5_000_000n;
/** Release plan output order. */
export const VAULT_OUT = 0;
export const RECIPIENT_OUT = 1;

/** A plan that does nothing yet; builders and attacks fill it. */
export const emptyPlan = (wallet: Wallet): TxPlan => ({
  scriptInputs: [],
  keyInputs: [],
  referenceInputs: [],
  mints: [],
  outputs: [],
  requiredSigners: [],
  validity: null,
  metadata: null,
  wallet,
});

/** Value minus (or plus) `delta` of one asset; zero entries are dropped (the ledger forbids them). */
export function shift(amount: Asset[], unit: string, delta: bigint): Asset[] {
  const has = amount.some((a) => a.unit === unit);
  const next = (has ? amount : [...amount, { unit, quantity: '0' }]).map((a) =>
    a.unit === unit ? { unit, quantity: (BigInt(a.quantity) + delta).toString() } : { ...a },
  );
  if (next.some((a) => BigInt(a.quantity) < 0n)) throw new Error(`insufficient ${unit}`);
  return next.filter((a) => BigInt(a.quantity) !== 0n);
}

const vaultValue = (asset: Asset['unit'], vaultHash: string, balance: bigint): Asset[] => [
  { unit: 'lovelace', quantity: VAULT_LOVELACE.toString() },
  { unit: vaultHash + VAULT_TOKEN, quantity: '1' },
  ...(balance > 0n ? [{ unit: asset, quantity: balance.toString() }] : []),
];

/** Plain payments (funding, fixtures). */
export function planPayment(outputs: PlanOutput[], wallet: Wallet): TxPlan {
  const plan = emptyPlan(wallet);
  plan.outputs = outputs;
  return plan;
}

// ## Creation (principal)

export function planAnchorMint(seed: UTxO, datum: AnchorDatum, principal: Wallet): { plan: TxPlan; script: Script } {
  assertDeployable(datum);
  const script = anchorScript(seed.input);
  const plan = emptyPlan(principal);
  plan.keyInputs = [seed];
  plan.mints = [{ policy: script.hash, name: MANDATE_TOKEN, quantity: 1n, script: script.cbor, redeemer: MINT_REDEEMER }];
  plan.outputs = [{ address: script.address, amount: [{ unit: script.hash + MANDATE_TOKEN, quantity: '1' }], datum: anchorDatumData(datum) }];
  plan.requiredSigners = [datum.principal_pkh];
  return { plan, script };
}

/** `anchor` is the minted anchor UTxO: the vault's `anchor_ref` is the policy of the NFT it actually holds. */
export function planVaultMint(
  asset: Deployment['asset'],
  anchor: AnchorState,
  seed: UTxO,
  fund: bigint,
  principal: Wallet,
): { plan: TxPlan; script: Script } {
  const anchorPolicy = anchor.utxo.output.amount.find((a) => a.unit.endsWith(MANDATE_TOKEN))?.unit.slice(0, 56);
  if (!anchorPolicy) throw new Error('anchor UTxO holds no MANDATE token');
  const script = vaultScript(anchorPolicy, 0, seed.input);
  const plan = emptyPlan(principal);
  plan.keyInputs = [seed];
  plan.referenceInputs = [anchor.utxo];
  plan.mints = [{ policy: script.hash, name: VAULT_TOKEN, quantity: 1n, script: script.cbor, redeemer: MINT_REDEEMER }];
  plan.outputs = [
    { address: script.address, amount: vaultValue(asset.policy + asset.name, script.hash, fund), datum: vaultDatumData(ZERO_VAULT_DATUM) },
  ];
  plan.requiredSigners = [anchor.datum.principal_pkh];
  return { plan, script };
}

/** One UTxO at the wallet's own address carrying the vault script, used as a reference script. */
export function planRefScript(script: Script, wallet: Wallet): TxPlan {
  const plan = emptyPlan(wallet);
  plan.outputs = [{ address: wallet.address, amount: [], referenceScript: script.cbor }];
  return plan;
}

// ## Release (executor, fee wallet)

export interface ReleaseInput {
  deployment: Deployment;
  anchor: AnchorState;
  vault: VaultState;
  refScript: UTxO;
  record: AuthorizationRecord;
  wallet: Wallet;
  nowMs: number;
  /** "M-001@3": metadata `mandate`. */
  mandateLabel: string;
  /** Evidence-log head at submit time; null only where no evidence log exists yet. */
  logHead: string | null;
}

/** Fails fast on anything the vault would reject for an honest executor, and on recipients it must not pay. */
export function checkRelease(x: ReleaseInput): void {
  const f = x.record.fields;
  const a = x.anchor.datum;
  if (!verifyAuthorizationRecord(x.record, a.engine_vkey)) throw new Error('authorization does not verify against the engine key on the anchor');
  if (f.vault_hash !== x.deployment.vault.hash || f.mandate_ref !== x.deployment.anchor.policy) throw new Error('authorization is for another vault or mandate');
  if (a.status !== 'active') throw new Error('mandate anchor is revoked');
  if (f.mandate_version !== a.version || f.mandate_hash !== a.mandate_hash) throw new Error('authorization is for another mandate version');
  if (BigInt(f.nonce) <= x.vault.datum.last_nonce) throw new Error('authorization nonce is not above the vault last_nonce');
  // R11: above the autonomous limit the flag is mandatory, and the flag means the approver co-signs.
  if (BigInt(f.amount) > a.autonomous_limit && !f.requires_principal) throw new Error('above the autonomous limit without requires_principal');
  // R16 puts an inline datum on the recipient output: a Plutus script recipient could not spend it.
  if (parseShelleyAddress(f.recipient).payment.tag !== 'key') throw new Error('recipient is a script address');
  const plan = releasePlan(x);
  if (plan.validity === null || plan.validity.upperSlot <= plan.validity.lowerSlot) throw new Error('authorization expired');
}

export function releasePlan(x: ReleaseInput): TxPlan {
  const f = x.record.fields;
  const unit = x.deployment.asset.policy + x.deployment.asset.name;
  const amount = BigInt(f.amount);
  const d = x.vault.datum;
  // R12 takes the day from L. Never let L fall before the vault's day (that release would fail r12) or, in the
  // first minute after midnight, before today's start (the engine counted it against today).
  const lowerMs = Math.max(x.nowMs - LOWER_OFFSET_MS, Number(d.day_index) * DAY_MS, Math.floor(x.nowMs / DAY_MS) * DAY_MS);
  if (lowerMs > x.nowMs) throw new Error('vault day_index is ahead of the clock');
  const lowerSlot = slotAt(lowerMs);
  const upper = Math.min(x.nowMs + UPPER_OFFSET_MS, f.valid_until, Number(x.anchor.datum.valid_until));
  const upperSlot = slotAt(upper);
  const day = BigInt(Math.floor(msAt(lowerSlot) / DAY_MS));
  if (day < d.day_index) throw new Error('validity lower bound is before the vault day');
  const next: VaultDatum = {
    last_nonce: BigInt(f.nonce),
    day_index: day,
    spent_today: day > d.day_index ? amount : d.spent_today + amount,
  };
  const continuing: PlanOutput = { address: x.vault.utxo.output.address, amount: shift(x.vault.utxo.output.amount, unit, -amount), datum: vaultDatumData(next) };
  // R16: exact amount to the exact address, inline datum = the digest, no reference script.
  const recipient: PlanOutput = { address: f.recipient, amount: [{ unit, quantity: amount.toString() }], datum: digestDatum(x.record) };
  const plan = emptyPlan(x.wallet);
  plan.scriptInputs = [{ utxo: x.vault.utxo, redeemer: releaseRedeemer(x.record), script: { ref: x.refScript, hash: x.deployment.vault.hash } }];
  plan.referenceInputs = [x.anchor.utxo];
  plan.outputs = [continuing, recipient];
  // R11: a flagged authorization needs the payment approver's signature (never the admin key).
  plan.requiredSigners = f.requires_principal ? [x.anchor.datum.approver_pkh] : [];
  plan.validity = { lowerSlot, upperSlot };
  plan.metadata = {
    auth: x.record.digest_hex,
    action: f.action_hash,
    mandate: x.mandateLabel,
    ...(x.logHead === null ? {} : { log_head: x.logHead }),
  };
  return plan;
}

export function planRelease(x: ReleaseInput): TxPlan {
  checkRelease(x);
  return releasePlan(x);
}

// ## Deposit (anyone) and PrincipalWithdraw (principal)

export function planDeposit(d: Deployment, anchor: AnchorState, vault: VaultState, refScript: UTxO, amount: bigint, wallet: Wallet): TxPlan {
  if (amount <= 0n) throw new Error('deposit must be positive');
  const plan = emptyPlan(wallet);
  plan.scriptInputs = [{ utxo: vault.utxo, redeemer: DEPOSIT, script: { ref: refScript, hash: d.vault.hash } }];
  plan.referenceInputs = [anchor.utxo];
  plan.outputs = [
    { address: vault.utxo.output.address, amount: shift(vault.utxo.output.amount, d.asset.policy + d.asset.name, amount), datum: vaultDatumData(vault.datum) },
  ];
  return plan;
}

/**
 * Spends vault-address UTxOs under the principal's signature. With `recreate`, the VAULT token goes back to
 * the vault with `balance` and a datum that keeps `lastNonce` (so every settled authorization stays dead, R8)
 * and starts a fresh daily window; everything else returns to `payer` as change.
 */
export function planWithdraw(
  d: Deployment,
  anchor: AnchorState,
  inputs: UTxO[],
  refScript: UTxO,
  payer: Wallet,
  recreate: { balance: bigint; lastNonce: bigint } | null,
): TxPlan {
  const plan = emptyPlan(payer);
  plan.scriptInputs = inputs.map((utxo) => ({ utxo, redeemer: PRINCIPAL_WITHDRAW, script: { ref: refScript, hash: d.vault.hash } }));
  plan.referenceInputs = [anchor.utxo];
  plan.requiredSigners = [anchor.datum.principal_pkh];
  if (recreate) {
    const datum: VaultDatum = { last_nonce: recreate.lastNonce, day_index: 0n, spent_today: 0n };
    plan.outputs = [{ address: d.vault.address, amount: vaultValue(d.asset.policy + d.asset.name, d.vault.hash, recreate.balance), datum: vaultDatumData(datum) }];
  }
  return plan;
}

/** The demo reset: the thread UTxO is recreated with `balance`, the same last_nonce and a fresh daily window. */
export const planVaultReset = (d: Deployment, anchor: AnchorState, vault: VaultState, refScript: UTxO, payer: Wallet, balance: bigint): TxPlan =>
  planWithdraw(d, anchor, [vault.utxo], refScript, payer, { balance, lastNonce: vault.datum.last_nonce });

// ## Anchor Update and Revoke (principal)

/** `payer` funds the tx (the principal, or the fee wallet when the principal signs in the browser). */
export function planAnchorUpdate(d: Deployment, anchor: AnchorState, next: AnchorDatum, payer: Wallet): TxPlan {
  assertDeployable(next);
  const plan = emptyPlan(payer);
  plan.scriptInputs = [{ utxo: anchor.utxo, redeemer: anchorUpdate(next), script: { inline: anchorScript(d.anchor.seed).cbor } }];
  plan.outputs = [{ address: anchor.utxo.output.address, amount: anchor.utxo.output.amount.map((a) => ({ ...a })), datum: anchorDatumData(next) }];
  plan.requiredSigners = [...new Set([anchor.datum.principal_pkh, next.principal_pkh])];
  return plan;
}

export function planAnchorRevoke(d: Deployment, anchor: AnchorState, payer: Wallet): TxPlan {
  const revoked: AnchorDatum = { ...anchor.datum, status: 'revoked', version: anchor.datum.version + 1 };
  const plan = emptyPlan(payer);
  plan.scriptInputs = [{ utxo: anchor.utxo, redeemer: ANCHOR_REVOKE, script: { inline: anchorScript(d.anchor.seed).cbor } }];
  plan.outputs = [{ address: anchor.utxo.output.address, amount: anchor.utxo.output.amount.map((a) => ({ ...a })), datum: anchorDatumData(revoked) }];
  plan.requiredSigners = [anchor.datum.principal_pkh];
  return plan;
}
