import { type Asset, MeshTxBuilder, type UTxO } from '@meshsdk/core';
import type { TxEnv } from './chain';
import type { PlutusJson } from './data';

export type ScriptSource = { inline: string } | { ref: UTxO; hash: string };

export interface ScriptInput {
  utxo: UTxO;
  redeemer: PlutusJson;
  script: ScriptSource;
}

export interface PlanOutput {
  address: string;
  /** Leave lovelace out to let the builder add the minimum ADA. */
  amount: Asset[];
  datum?: PlutusJson;
  referenceScript?: string;
}

export interface PlanMint {
  policy: string;
  name: string;
  quantity: bigint;
  script: string;
  redeemer: PlutusJson;
}

/** Pays fees, minimum ADA and collateral, and receives the change. */
export interface Wallet {
  address: string;
  utxos: UTxO[];
}

/** A complete, explicit description of one transaction. Builders produce it; attacks edit it. */
export interface TxPlan {
  scriptInputs: ScriptInput[];
  keyInputs: UTxO[];
  referenceInputs: UTxO[];
  mints: PlanMint[];
  outputs: PlanOutput[];
  requiredSigners: string[];
  validity: { lowerSlot: number; upperSlot: number } | null;
  metadata: Record<string, string> | null;
  wallet: Wallet;
}

export const METADATA_LABEL = 1694;
/** Placeholder budget before evaluation replaces it, and the fixed budget of attack txs (never evaluated). */
export const FIXED_BUDGET = { mem: 7_000_000, steps: 3_000_000_000 };
const COLLATERAL_MIN = 5_000_000n;

const lovelace = (u: UTxO) => BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');
const spendable = (u: UTxO) => !u.output.scriptRef;
/** Tx hash plus output index. Callers may pass a copy of a wallet UTxO, so identity is not enough. */
const outpoint = (u: UTxO) => `${u.input.txHash}#${u.input.outputIndex}`;

/** The smallest ADA-only UTxO of at least 5 ADA that is not already a key input. buildTx never spends it, so it stays usable as collateral. */
export function pickCollateral(w: Wallet, keyInputs: UTxO[] = []): UTxO {
  const taken = new Set(keyInputs.map(outpoint));
  const pure = w.utxos
    .filter((u) => spendable(u) && !taken.has(outpoint(u)) && u.output.amount.length === 1 && lovelace(u) >= COLLATERAL_MIN)
    .sort((a, b) => (lovelace(a) < lovelace(b) ? -1 : lovelace(a) > lovelace(b) ? 1 : 0));
  if (!pure[0]) throw new Error(`wallet ${w.address} has no ADA-only UTxO of at least 5 ADA for collateral`);
  return pure[0];
}

/**
 * Serializes a plan into an unsigned tx. Without `fixedBudget` every redeemer gets its budget from a real
 * evaluation (env.evaluator). With `fixedBudget` nothing is evaluated: used to submit txs that must fail.
 */
export async function buildTx(env: TxEnv, plan: TxPlan, fixedBudget: { mem: number; steps: number } | null = null): Promise<string> {
  const tx = new MeshTxBuilder({
    params: env.params,
    ...(env.fetcher ? { fetcher: env.fetcher } : {}),
    ...(fixedBudget ? {} : { evaluator: env.evaluator }),
  });
  // 10% headroom over the local evaluation, in case the node's accounting differs slightly.
  tx.txEvaluationMultiplier = 1.1;
  const budget = fixedBudget ?? FIXED_BUDGET;
  for (const s of plan.scriptInputs) {
    const { txHash, outputIndex } = s.utxo.input;
    tx.spendingPlutusScriptV3().txIn(txHash, outputIndex, s.utxo.output.amount, s.utxo.output.address, 0);
    if ('inline' in s.script) tx.txInScript(s.script.inline);
    else {
      const ref = s.script.ref;
      tx.spendingTxInReference(ref.input.txHash, ref.input.outputIndex, String((ref.output.scriptRef ?? '').length / 2), s.script.hash);
    }
    if (s.utxo.output.plutusData) tx.txInInlineDatumPresent();
    tx.txInRedeemerValue(s.redeemer, 'JSON', { ...budget });
  }
  for (const u of plan.keyInputs) tx.txIn(u.input.txHash, u.input.outputIndex, u.output.amount, u.output.address, 0);
  for (const u of plan.referenceInputs) {
    tx.readOnlyTxInReference(u.input.txHash, u.input.outputIndex, (u.output.scriptRef ?? '').length / 2);
  }
  for (const m of plan.mints) {
    tx.mintPlutusScriptV3().mint(m.quantity.toString(), m.policy, m.name).mintingScript(m.script);
    tx.mintRedeemerValue(m.redeemer, 'JSON', { ...budget });
  }
  for (const o of plan.outputs) {
    tx.txOut(o.address, o.amount.map((a) => ({ ...a })));
    if (o.datum) tx.txOutInlineDatumValue(o.datum, 'JSON');
    if (o.referenceScript) tx.txOutReferenceScript(o.referenceScript, 'V3');
  }
  for (const pkh of plan.requiredSigners) tx.requiredSignerHash(pkh);
  if (plan.validity) tx.invalidBefore(plan.validity.lowerSlot).invalidHereafter(plan.validity.upperSlot);
  if (plan.metadata) tx.metadataValue(METADATA_LABEL, plan.metadata);
  let collateral: UTxO | null = null;
  if (plan.scriptInputs.length > 0 || plan.mints.length > 0) {
    collateral = pickCollateral(plan.wallet, plan.keyInputs);
    tx.txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address);
  }
  const held = new Set(plan.keyInputs.map(outpoint));
  if (collateral) held.add(outpoint(collateral));
  tx.changeAddress(plan.wallet.address).selectUtxosFrom(plan.wallet.utxos.filter((u) => spendable(u) && !held.has(outpoint(u))));
  return tx.complete();
}
