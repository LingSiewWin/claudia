import type { AuthorizationFields, AuthorizationRecord, ChainBinding, EscalationPrice, Mandate } from '@authority/core';
import { type BondOutcome, type BondUtxo, buildBondSpend as buildBondSpendTx, escrowAddress, readBond as readBondUtxo, sinkAddress } from './bond';
import { hexOfLength } from '@authority/core';
import { resolveTxHash, serializeData } from '@meshsdk/core';
import { FIXED_BUDGET, type TxPlan, type Wallet, buildTx } from './build';
import { BLOCKFROST, type Chain, awaitTx, connect, evaluateTx, submit, submitRaw, tipSlot, txOnChain } from './chain';
import { digestDatum } from './data';
import { type Deployment, anchorDatumFor, chainBinding, loadDeployments, mandateAt } from './deployment';
import { ATTACKS, type Attack, type LabContext as AttackContext, dailyCapPrimed, labRecord } from './lab';
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
  bondAddresses(): { escrow: string; sink: string };
  readBond(price: Pick<EscalationPrice, 'approval_id' | 'action_hash' | 'amount' | 'approver_key_hash' | 'network'>): Promise<BondUtxo | null>;
  buildBondSpend(bond: BondUtxo, outcome: BondOutcome): Promise<UnsignedTx>;
  submitSigned(txCbor: string): Promise<{ tx_hash: string; accepted: boolean; detail: string }>;
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

export interface LabAttemptResult {
  code: string;
  tx_hash: string | null;
  funds_moved: string;
  /** `not_primed` means no attack transaction was built or submitted. */
  outcome: 'submitted' | 'not_primed';
}

export interface LabRunner {
  run(attack: VaultAttack, ctx: PortLabContext): Promise<LabAttemptResult>;
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

/**
 * Classifies an evaluation failure. Contention (a spent or missing input) stays CONTENTION so the
 * executor can retry it. Every other evaluation failure is SCRIPT_FAILED, with the trace's invariant kept.
 */
export function evaluationFailure(message: string, logs: string[], txCbor: string): CardanoError {
  const text = [...logs, message].join('\n');
  const classified = toCardanoError(new Error(text), txCbor);
  if (classified.code === 'CONTENTION') return classified;
  return new CardanoError('SCRIPT_FAILED', message, invariantFrom(text), txCbor);
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

async function blockfrostGet(chain: Chain, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BLOCKFROST}${path}`, { headers: { project_id: chain.projectId }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: JSON.parse(text) as unknown };
}

const RELEASE_PAGE = 100;
/** Past this many full pages the lookup throws. Returning null would let authorize issue again. */
const RELEASE_PAGE_LIMIT = 50;

function listedTxs(body: unknown): { tx_hash: string }[] {
  if (!Array.isArray(body)) throw new Error('release lookup: expected a transaction list');
  return body.map((row) => {
    if (!row || typeof row !== 'object' || typeof (row as { tx_hash?: unknown }).tx_hash !== 'string') {
      throw new Error('release lookup: transaction row has no tx_hash');
    }
    return { tx_hash: (row as { tx_hash: string }).tx_hash };
  });
}

function utxoOutputs(body: unknown): { address: string; inline_datum: string | null }[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { outputs?: unknown }).outputs)) {
    throw new Error('release lookup: expected transaction outputs');
  }
  return (body as { outputs: unknown[] }).outputs.map((o) => {
    if (!o || typeof o !== 'object') throw new Error('release lookup: bad output');
    const out = o as { address?: unknown; inline_datum?: unknown };
    if (typeof out.address !== 'string') throw new Error('release lookup: output has no address');
    if (out.inline_datum != null && typeof out.inline_datum !== 'string') throw new Error('release lookup: inline datum is not hex');
    return { address: out.address, inline_datum: typeof out.inline_datum === 'string' ? out.inline_datum : null };
  });
}

/**
 * Confirmed tx whose recipient output carries this authorization's digest.
 * Null only for a real empty list or a 404. Any other HTTP status throws, and pages continue until a
 * confirmed hit or a short page, so a blip or an older release cannot look like "no release."
 */
export async function findConfirmedRelease(
  get: (path: string) => Promise<{ status: number; body: unknown }>,
  confirmed: (txHash: string) => Promise<boolean>,
  authorization: AuthorizationRecord,
): Promise<string | null> {
  const want = serializeData(digestDatum(authorization), 'JSON');
  const recipient = authorization.fields.recipient;
  for (let page = 1; page <= RELEASE_PAGE_LIMIT; page++) {
    const listed = await get(`/addresses/${encodeURIComponent(recipient)}/transactions?order=desc&count=${RELEASE_PAGE}&page=${page}`);
    if (listed.status === 404 && page === 1) return null;
    if (listed.status !== 200) throw new Error(`release lookup failed (${listed.status})`);
    const rows = listedTxs(listed.body);
    for (const row of rows) {
      const utxos = await get(`/txs/${row.tx_hash}/utxos`);
      if (utxos.status !== 200) throw new Error(`release lookup utxos ${row.tx_hash} failed (${utxos.status})`);
      const hit = utxoOutputs(utxos.body).some(
        (o) => o.address === recipient && (o.inline_datum === want || (o.inline_datum?.includes(authorization.digest_hex) ?? false)),
      );
      if (hit && (await confirmed(row.tx_hash))) return row.tx_hash;
    }
    if (rows.length < RELEASE_PAGE) return null;
  }
  throw new Error(`release lookup did not finish within ${RELEASE_PAGE_LIMIT} pages`);
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
        if (!ev.ok) throw evaluationFailure(ev.message, ev.logs, tx);
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
      return findConfirmedRelease(
        (path) => blockfrostGet(chain, path),
        async (txHash) => (await txOnChain(chain, txHash)) !== null,
        authorization,
      );
    },
    bondAddresses() {
      return { escrow: escrowAddress(0), sink: sinkAddress(0) };
    },
    async readBond(price) {
      return readBondUtxo(await chainOf(), price);
    },
    async buildBondSpend(bond, outcome) {
      const chain = await chainOf();
      return buildBondSpendTx(chain, await feeOf(), bond, outcome);
    },
    async submitSigned(txCbor) {
      const r = await submitRaw(await chainOf(), txCbor);
      return { tx_hash: resolveTxHash(txCbor), accepted: r.ok, detail: r.body };
    },
  };
}

export type PreparedAttack =
  | { kind: 'attack'; attack: Attack; record: AuthorizationRecord | null }
  | { kind: 'revoke_then_attack'; revoke: TxPlan; record: AuthorizationRecord }
  | { kind: 'not_primed'; code: 'NOT_PRIMED' };

/**
 * Chooses the transaction a lab attack may submit. Replay uses a nonce that is already spent.
 * Revoked builds the pre-revoke record, then a `planAnchorRevoke` — the record is not a release plan yet.
 * daily_cap returns not_primed until `dailyCapPrimed`, so the runner does not submit and does not pretend it did.
 * Neither replay nor revoked asks the engine to authorize an open invoice.
 */
export function prepareLabAttack(attack: VaultAttack, lab: AttackContext): PreparedAttack {
  if (attack === 'replay') {
    const record = labRecord(lab, { nonce: lab.vault.datum.last_nonce.toString() });
    if (BigInt(record.fields.nonce) > lab.vault.datum.last_nonce) throw new Error('replay nonce is still spendable');
    return { kind: 'attack', attack: ATTACKS.replay(lab, record), record };
  }
  if (attack === 'revoked') {
    return { kind: 'revoke_then_attack', revoke: planAnchorRevoke(lab.deployment, lab.anchor, lab.executor), record: labRecord(lab) };
  }
  if (attack === 'daily_cap' && !dailyCapPrimed(lab)) return { kind: 'not_primed', code: 'NOT_PRIMED' };
  return { kind: 'attack', attack: attackOf(attack, lab), record: null };
}

function attackOf(attack: Exclude<VaultAttack, 'replay' | 'revoked'>, lab: AttackContext): Attack {
  switch (attack) {
    case 'recipient_swap':
      return ATTACKS.recipient_swap(lab);
    case 'amount_swap':
      return ATTACKS.amount_swap(lab);
    case 'expired':
      return ATTACKS.expired(lab);
    case 'daily_cap':
      return ATTACKS.daily_cap(lab);
    case 'cfo_bypass':
      return ATTACKS.cfo_bypass(lab);
  }
}

/** Runs a prepared attack. The pre-revoke record is submitted only after the anchor read comes back revoked. */
export async function runPrepared(
  prepared: PreparedAttack,
  io: {
    revoke(plan: TxPlan): Promise<AttackContext>;
    submit(attack: Attack): Promise<LabAttemptResult>;
  },
): Promise<LabAttemptResult> {
  if (prepared.kind === 'not_primed') return { code: prepared.code, tx_hash: null, funds_moved: '0', outcome: 'not_primed' };
  if (prepared.kind === 'attack') return io.submit(prepared.attack);
  const next = await io.revoke(prepared.revoke);
  if (next.anchor.datum.status !== 'revoked') {
    throw new Error('anchor revoke did not leave the anchor revoked; the pre-revoke release was not submitted');
  }
  return io.submit(ATTACKS.revoked(next, prepared.record));
}

/** M-LAB vault attacks. Reads M_LAB_*, the fee wallet, Blockfrost, and the demo vendor address. */
export function createLabRunner(env: Env, cardano: CardanoPort): LabRunner | null {
  return {
    async run(attack, ctx) {
      const chain = await connect(env.BLOCKFROST_PROJECT_ID_PREPROD);
      const fee = await walletFromMnemonic(chain, env.FEE_WALLET_MNEMONIC, 'FEE_WALLET_MNEMONIC');
      const d = loadDeployments()['M-LAB'];
      if (!d) throw new Error('no M-LAB deployment');
      const engineSecretKey = hexOfLength(env.M_LAB_ENGINE_SECRET_KEY ?? '', 32, 'M_LAB_ENGINE_SECRET_KEY');
      const payee = env.DEMO_VENDOR_AWS_ADDRESS ?? '';
      const readLab = async (): Promise<AttackContext> => {
        const s = await snapshot(chain, d, fee);
        return {
          deployment: d,
          anchor: s.anchor,
          vault: s.vault,
          refScript: s.refScript,
          executor: s.wallet,
          engineSecretKey,
          payee,
          actionHash: '00'.repeat(32),
          nowMs: Date.now(),
        };
      };
      const lab = await readLab();
      const prepared = prepareLabAttack(attack, lab);
      const principalBox: { wallet?: SigningWallet } = {};
      let revoked = false;
      try {
        return await runPrepared(prepared, {
          async revoke(plan) {
            const principal = await walletFromMnemonic(chain, env.M_LAB_PRINCIPAL_MNEMONIC, 'M_LAB_PRINCIPAL_MNEMONIC');
            if (principal.pkh !== lab.anchor.datum.principal_pkh) throw new Error('M_LAB_PRINCIPAL_MNEMONIC is not the M-LAB admin key');
            principalBox.wallet = principal;
            let signed = await fee.sign(await buildTx(chain, plan));
            signed = await principal.sign(signed);
            const txHash = await submit(chain, signed);
            await awaitTx(chain, txHash);
            revoked = true;
            await ctx.record('MandateUpdated', null, { attack, tx_hash: txHash, status: 'revoked' });
            return readLab();
          },
          async submit(built) {
            const tx = await buildTx(chain, built.plan, FIXED_BUDGET);
            const txHash = resolveTxHash(tx);
            await ctx.record('TransactionBuilt', null, { attack, tx_hash: txHash, trace: built.trace });
            const posted = await submitRaw(chain, await fee.sign(tx));
            const code = invariantFrom(built.trace) ?? invariantFrom(`${posted.body}\n${built.trace}`) ?? built.trace;
            if (posted.ok) await ctx.record('TransactionSubmitted', null, { attack, tx_hash: txHash });
            else await ctx.record('TransactionRejected', null, { attack, tx_hash: txHash, body: posted.body, code });
            const after = await cardano.readVaultState(chainBinding(d));
            return { code, tx_hash: txHash, funds_moved: (lab.vault.balance - after.balance).toString(), outcome: 'submitted' };
          },
        });
      } finally {
        const principal = principalBox.wallet;
        if (revoked && principal) {
          try {
            const now = await readLab();
            if (now.anchor.datum.status === 'revoked') {
              const next = anchorDatumFor(mandateAt(d, now.anchor.datum.version + 1), d.asset);
              let signed = await fee.sign(await buildTx(chain, planAnchorUpdate(d, now.anchor, next, now.executor)));
              signed = await principal.sign(signed);
              const txHash = await submit(chain, signed);
              await awaitTx(chain, txHash);
              await ctx.record('MandateUpdated', null, { attack, tx_hash: txHash, status: 'active' });
            }
          } catch (error) {
            await ctx.record('TransactionRejected', null, {
              attack,
              step: 'reactivate',
              error: error instanceof Error ? error.message : String(error),
            }).catch(() => undefined);
          }
        }
      }
    },
  };
}
