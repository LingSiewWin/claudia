import type { AuthorizationFields, AuthorizationRecord, ChainBinding, Mandate } from '@authority/core';
import { fieldsFromRecord, hexOfLength } from '@authority/core';
import { resolveTxHash, serializeData } from '@meshsdk/core';
import { FIXED_BUDGET, type Wallet, buildTx } from './build';
import { BLOCKFROST, type Chain, connect, evaluateTx, submit, submitRaw, tipSlot, txOnChain } from './chain';
import { digestDatum } from './data';
import { type Deployment, anchorDatumFor, loadDeployments } from './deployment';
import { ATTACKS, type LabContext as AttackContext, labRecord } from './lab';
import { type AnchorState as OnchainAnchor, type VaultState as OnchainVault, readAnchor, readRefScript, readVault } from './state';
import { planAnchorRevoke, planAnchorUpdate, planRelease } from './txs';
import { addWitnessSet, type SigningWallet, walletFromMnemonic } from './wallet';

export type CardanoErrorCode = 'SCRIPT_FAILED' | 'CONTENTION' | 'SUBMIT_FAILED';

export class CardanoError extends Error {
  constructor(
    readonly code: CardanoErrorCode,
    message: string,
    readonly invariant: string | null = null,
    readonly txCbor: string | null = null,
  ) {
    super(message);
  }
}

export interface PortVaultState {
  balance: bigint;
  spent_today: bigint;
  day_index: number;
  last_nonce: bigint;
  tx_hash: string;
  slot: number;
}

export interface PortAnchorState {
  mandate_hash: string;
  version: number;
  status: 'active' | 'revoked';
  principal_pkh: string;
  approver_pkh: string;
  tx_hash: string;
}

export interface SettlementMetadata {
  auth: string;
  action: string;
  mandate: string;
  log_head: { seq: number; hash: string };
}

export interface UnsignedTx {
  txCbor: string;
  txHash: string;
}

export interface CardanoPort {
  readVaultState(binding: ChainBinding): Promise<PortVaultState>;
  readAnchor(binding: ChainBinding): Promise<PortAnchorState>;
  buildRelease(input: {
    binding: ChainBinding;
    authorization: AuthorizationRecord;
    metadata: SettlementMetadata;
    cfoKeyHash: string | null;
  }): Promise<UnsignedTx>;
  buildAnchorUpdate(input: { binding: ChainBinding; mandate: Mandate }): Promise<UnsignedTx>;
  buildAnchorRevoke(input: { binding: ChainBinding }): Promise<UnsignedTx>;
  submit(input: { txCbor: string; witnessSets: string[] }): Promise<string>;
  awaitConfirmation(txHash: string, untilMs: number): Promise<{ block_height: number } | null>;
  releaseOf(binding: ChainBinding, authorization: AuthorizationRecord): Promise<string | null>;
}

export type VaultAttack = 'recipient_swap' | 'amount_swap' | 'replay' | 'expired' | 'revoked' | 'daily_cap' | 'cfo_bypass';
export type LabEventType =
  | 'TransactionBuilt'
  | 'TransactionSubmitted'
  | 'TransactionConfirmed'
  | 'TransactionRejected'
  | 'MandateUpdated';

export interface PortLabContext {
  authorize(invoiceNumber: string): Promise<AuthorizationRecord>;
  forge(fields: AuthorizationFields): Promise<AuthorizationRecord>;
  record(type: LabEventType, actionId: string | null, payload: Record<string, unknown>): Promise<void>;
}

export interface LabRunner {
  run(attack: VaultAttack, ctx: PortLabContext): Promise<{ code: string; tx_hash: string | null; funds_moved: string }>;
}

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

function deploymentOf(binding: ChainBinding): Deployment {
  const found = Object.values(loadDeployments()).find((d) => d.vault.hash === binding.vaultHash && d.anchor.policy === binding.mandateRef);
  if (!found) throw new Error(`no deployment for vault ${binding.vaultHash}`);
  return found;
}

function invariantFrom(text: string): string | null {
  const script = /\b([rRwWmMvVuU])(\d+)\s*\?\s*False/.exec(text);
  const letter = script?.[1];
  const n = script?.[2];
  if (letter && n) return `${letter.toUpperCase()}${n}`;
  if (/update_signed/i.test(text)) return 'U1';
  if (/revoke_signed/i.test(text)) return 'U2';
  return null;
}

function toCardanoError(error: unknown, txCbor: string | null): CardanoError {
  if (error instanceof CardanoError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const invariant = invariantFrom(message);
  if (/BadInputs|already spent|ValueNotConserved|UnknownOrMissing|contention/i.test(message)) {
    return new CardanoError('CONTENTION', message, invariant, txCbor);
  }
  if (invariant || /script|evaluat/i.test(message)) return new CardanoError('SCRIPT_FAILED', message, invariant, txCbor);
  return new CardanoError('SUBMIT_FAILED', message, invariant, txCbor);
}

async function built(chain: Chain, plan: Parameters<typeof buildTx>[1], fixedBudget: { mem: number; steps: number } | null = null): Promise<UnsignedTx> {
  try {
    const txCbor = await buildTx(chain, plan, fixedBudget);
    return { txCbor, txHash: resolveTxHash(txCbor) };
  } catch (error) {
    throw toCardanoError(error, null);
  }
}

async function snapshot(chain: Chain, d: Deployment, fee: SigningWallet): Promise<{
  anchor: OnchainAnchor;
  vault: OnchainVault;
  refScript: Awaited<ReturnType<typeof readRefScript>>;
  wallet: Wallet;
}> {
  const [anchor, vault, refScript, wallet] = await Promise.all([
    readAnchor(chain.provider, d),
    readVault(chain.provider, d),
    readRefScript(chain.provider, d),
    fee.snapshot(),
  ]);
  return { anchor, vault, refScript, wallet };
}

async function blockfrostJson<T>(chain: Chain, path: string): Promise<{ status: number; body: T | null; text: string }> {
  const res = await fetch(`${BLOCKFROST}${path}`, { headers: { project_id: chain.projectId } });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: null, text };
  return { status: res.status, body: JSON.parse(text) as T, text };
}

/** Authority Cardano port: existing readers, plan* builders, and submit. Connects on first use. */
export function createCardanoPort(env: Env): CardanoPort {
  let chainP: Promise<Chain> | undefined;
  let feeP: Promise<SigningWallet> | undefined;
  const chainOf = () => (chainP ??= connect(env.BLOCKFROST_PROJECT_ID_PREPROD));
  const feeOf = async () => (feeP ??= walletFromMnemonic(await chainOf(), env.FEE_WALLET_MNEMONIC, 'FEE_WALLET_MNEMONIC'));

  return {
    async readVaultState(binding) {
      const chain = await chainOf();
      const [vault, slot] = await Promise.all([readVault(chain.provider, deploymentOf(binding)), tipSlot(chain)]);
      return {
        balance: vault.balance,
        spent_today: vault.datum.spent_today,
        day_index: Number(vault.datum.day_index),
        last_nonce: vault.datum.last_nonce,
        tx_hash: vault.utxo.input.txHash,
        slot,
      };
    },
    async readAnchor(binding) {
      const chain = await chainOf();
      const anchor = await readAnchor(chain.provider, deploymentOf(binding));
      return {
        mandate_hash: anchor.datum.mandate_hash,
        version: anchor.datum.version,
        status: anchor.datum.status,
        principal_pkh: anchor.datum.principal_pkh,
        approver_pkh: anchor.datum.approver_pkh,
        tx_hash: anchor.utxo.input.txHash,
      };
    },
    async buildRelease({ binding, authorization, metadata, cfoKeyHash }) {
      const chain = await chainOf();
      const d = deploymentOf(binding);
      const s = await snapshot(chain, d, await feeOf());
      const plan = planRelease({
        deployment: d,
        anchor: s.anchor,
        vault: s.vault,
        refScript: s.refScript,
        record: authorization,
        wallet: s.wallet,
        nowMs: Date.now(),
        mandateLabel: metadata.mandate,
        logHead: metadata.log_head,
      });
      plan.metadata = { auth: metadata.auth, action: metadata.action, mandate: metadata.mandate, log_head: metadata.log_head };
      if (cfoKeyHash && !plan.requiredSigners.includes(cfoKeyHash)) plan.requiredSigners.push(cfoKeyHash);
      return built(chain, plan);
    },
    async buildAnchorUpdate({ binding, mandate }) {
      const chain = await chainOf();
      const d = deploymentOf(binding);
      const s = await snapshot(chain, d, await feeOf());
      return built(chain, planAnchorUpdate(d, s.anchor, anchorDatumFor(mandate, d.asset), s.wallet));
    },
    async buildAnchorRevoke({ binding }) {
      const chain = await chainOf();
      const d = deploymentOf(binding);
      const s = await snapshot(chain, d, await feeOf());
      return built(chain, planAnchorRevoke(d, s.anchor, s.wallet));
    },
    async submit({ txCbor, witnessSets }) {
      const chain = await chainOf();
      const fee = await feeOf();
      let tx = txCbor;
      try {
        tx = await fee.sign(txCbor);
        for (const set of witnessSets) tx = addWitnessSet(tx, set);
        const ev = await evaluateTx(chain, tx);
        if (!ev.ok) {
          const text = [...ev.logs, ev.message].join('\n');
          throw new CardanoError('SCRIPT_FAILED', ev.message, invariantFrom(text), tx);
        }
        return await submit(chain, tx);
      } catch (error) {
        throw toCardanoError(error, tx);
      }
    },
    async awaitConfirmation(txHash, untilMs) {
      const chain = await chainOf();
      for (;;) {
        const info = await txOnChain(chain, txHash);
        if (info) return info;
        const wait = Math.min(5_000, Math.max(0, untilMs - Date.now()));
        if (wait === 0) return null;
        await new Promise((r) => setTimeout(r, wait));
      }
    },
    async releaseOf(binding, authorization) {
      const chain = await chainOf();
      deploymentOf(binding);
      const want = serializeData(digestDatum(authorization), 'JSON');
      const listed = await blockfrostJson<{ tx_hash: string }[]>(
        chain,
        `/addresses/${authorization.fields.recipient}/transactions?order=desc&count=100`,
      );
      if (listed.status !== 200 || !listed.body) return null;
      for (const row of listed.body) {
        const utxos = await blockfrostJson<{ outputs: { address: string; inline_datum: string | null }[] }>(chain, `/txs/${row.tx_hash}/utxos`);
        const hit = utxos.body?.outputs.some(
          (o) => o.address === authorization.fields.recipient && (o.inline_datum === want || (o.inline_datum?.includes(authorization.digest_hex) ?? false)),
        );
        if (hit && (await txOnChain(chain, row.tx_hash))) return row.tx_hash;
      }
      return null;
    },
  };
}

function attackPlan(attack: VaultAttack, lab: AttackContext, issued: AuthorizationRecord) {
  if (attack === 'replay') return ATTACKS.replay(lab, issued);
  if (attack === 'revoked') return ATTACKS.revoked(lab, issued);
  return ATTACKS[attack](lab);
}

/** M-LAB vault attacks. Reads only M_LAB_*, the fee wallet, Blockfrost, and the demo vendor address. */
export function createLabRunner(env: Env, cardano: CardanoPort): LabRunner | null {
  return {
    async run(attack, ctx) {
      const chain = await connect(env.BLOCKFROST_PROJECT_ID_PREPROD);
      const fee = await walletFromMnemonic(chain, env.FEE_WALLET_MNEMONIC, 'FEE_WALLET_MNEMONIC');
      const d = loadDeployments()['M-LAB'];
      if (!d) throw new Error('no M-LAB deployment');
      const s = await snapshot(chain, d, fee);
      const lab: AttackContext = {
        deployment: d,
        anchor: s.anchor,
        vault: s.vault,
        refScript: s.refScript,
        executor: s.wallet,
        engineSecretKey: hexOfLength(env.M_LAB_ENGINE_SECRET_KEY ?? '', 32, 'M_LAB_ENGINE_SECRET_KEY'),
        payee: env.DEMO_VENDOR_AWS_ADDRESS ?? '',
        actionHash: '00'.repeat(32),
        nowMs: Date.now(),
      };
      const invoice = env.M_LAB_INVOICE_NUMBER ?? '';
      const issued =
        attack === 'replay' || attack === 'revoked'
          ? invoice
            ? await ctx.authorize(invoice)
            : await ctx.forge(fieldsFromRecord(labRecord(lab)))
          : labRecord(lab);
      const a = attackPlan(attack, lab, issued);
      const tx = await buildTx(chain, a.plan, FIXED_BUDGET);
      const txHash = resolveTxHash(tx);
      await ctx.record('TransactionBuilt', null, { attack, tx_hash: txHash, trace: a.trace });
      const signed = await fee.sign(tx);
      const result = await submitRaw(chain, signed);
      const code = invariantFrom(a.trace) ?? invariantFrom(`${result.body}\n${a.trace}`) ?? a.trace;
      if (result.ok) await ctx.record('TransactionSubmitted', null, { attack, tx_hash: txHash });
      else await ctx.record('TransactionRejected', null, { attack, tx_hash: txHash, body: result.body, code });
      const after = await cardano.readVaultState({
        chainTag: d.chain_tag,
        vaultHash: d.vault.hash,
        mandateRef: d.anchor.policy,
        assetPolicy: d.asset.policy,
        assetName: d.asset.name,
        assetSymbol: d.mandate.asset.symbol,
      });
      const funds_moved = (s.vault.balance - after.balance).toString();
      return { code, tx_hash: txHash, funds_moved };
    },
  };
}
