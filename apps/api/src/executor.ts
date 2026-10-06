import type { AuthorizationRecord } from '@authority/core';
import { chainHead, type Db } from '@authority/db';
import type { EventLog } from './log';
import { type MandateRow, mandateRowAt } from './mandates';
import { CardanoError, type CardanoPort, type Settle, type UnsignedTx } from './ports';
import { type DecisionContext, receiptBody, storeReceipt } from './receipts';
import { completeRun } from './runs';

export interface ExecutorDeps {
  db: Db;
  log: EventLog;
  now: () => number;
  cardano: CardanoPort;
  settle: Settle;
}

export interface Executor {
  enqueue(authorizationId: number): void;
  /** Resolves when everything enqueued so far has finished. */
  idle(): Promise<void>;
  /** After a restart: continue queued and submitted releases, retry Stripe marking. */
  resume(): Promise<void>;
}

const CONTENTION_RETRIES = 3;
/** An authorization this close to expiry is not submitted: the tx could not finish inside its validity window. */
export const EXPIRY_MARGIN_MS = 60_000;

/**
 * Builds the release and logs TransactionBuilt. log_head = { seq, hash } of the last event already in the log when
 * the release is built; the tx metadata commits it on-chain (the tx body is signed, so the head cannot include the
 * event that names the tx). Anyone can recompute the stored chain up to seq and compare with hash.
 */
export async function buildRelease(
  deps: Pick<ExecutorDeps, 'db' | 'log' | 'cardano'>,
  row: MandateRow,
  record: AuthorizationRecord,
  cfoKeyHash: string | null,
  where: { runId: string; actionId: string },
): Promise<UnsignedTx> {
  const logHead = await chainHead(deps.db);
  const metadata = {
    auth: record.digest_hex,
    action: record.fields.action_hash,
    mandate: `${row.mandate.id}@${row.mandate.version}`,
    log_head: logHead,
  };
  const tx = await deps.cardano.buildRelease({ binding: row.binding, authorization: record, metadata, cfoKeyHash });
  await deps.log.emit({
    run_id: where.runId,
    action_id: where.actionId,
    type: 'TransactionBuilt',
    payload: { tx_hash: tx.txHash, tx_body_cbor: tx.txCbor, log_head: logHead },
  });
  return tx;
}

interface AuthRow {
  id: string;
  run_id: string;
  mandate_id: string;
  invoice_id: string | null;
  action_id: string;
  record: string;
  context: string;
  status: string;
  unsigned_tx: string | null;
  tx_hash: string | null;
  cfo_witness: string | null;
}

async function execute(deps: ExecutorDeps, id: number): Promise<void> {
  const { db, log, cardano } = deps;
  const [a] = await db.query<AuthRow>(
    `select id::text as id, run_id::text as run_id, mandate_id, invoice_id, action_id, record, context, status,
       unsigned_tx, tx_hash, cfo_witness from authorizations where id = $1`,
    [id],
  );
  if (!a || (a.status !== 'queued' && a.status !== 'submitted')) return;
  const record = JSON.parse(a.record) as AuthorizationRecord;
  const ctx = JSON.parse(a.context) as DecisionContext;
  const row = await mandateRowAt(db, a.mandate_id, ctx.mandate_version);
  const emit = (type: string, payload: unknown) => log.emit({ run_id: a.run_id, action_id: a.action_id, type, payload });
  const fail = async (invariant: string, error: string, txHash: string | null, txCbor: string | null) => {
    await db.query(`update authorizations set status = 'failed', error = $2 where id = $1`, [id, `${invariant}: ${error}`]);
    await emit('TransactionRejected', { tx_hash: txHash, invariant, error, tx_body_cbor: txCbor });
  };

  let txHash = a.tx_hash;
  if (a.status === 'queued') {
    for (let attempt = 1; ; attempt++) {
      if (deps.now() > record.fields.valid_until - EXPIRY_MARGIN_MS) {
        return fail('EXPIRED', 'the authorization expires before a release could settle; the agent must propose again', null, null);
      }
      const vault = await cardano.readVaultState(row.binding);
      if (BigInt(record.fields.nonce) <= vault.last_nonce) {
        return fail('R8', `nonce ${record.fields.nonce} is not above the vault's last nonce ${vault.last_nonce}`, null, null);
      }
      let tx: UnsignedTx | null = null;
      try {
        // CFO path: submit exactly the body the CFO signed. Otherwise build against the current vault UTxO.
        tx =
          a.unsigned_tx && a.tx_hash
            ? { txCbor: a.unsigned_tx, txHash: a.tx_hash }
            : await buildRelease(deps, row, record, null, { runId: a.run_id, actionId: a.action_id });
        txHash = await cardano.submit({ txCbor: tx.txCbor, witnessSets: a.cfo_witness ? [a.cfo_witness] : [] });
      } catch (error) {
        const e = error instanceof CardanoError ? error : new CardanoError('SUBMIT_FAILED', (error as Error).message);
        // Contention: same authorization (same nonce, same signature) against a fresh vault UTxO. Never re-signed.
        if (e.code === 'CONTENTION' && !a.unsigned_tx && attempt < CONTENTION_RETRIES) continue;
        return fail(e.invariant ?? e.code, e.message, tx?.txHash ?? null, e.txCbor ?? tx?.txCbor ?? null);
      }
      await db.query(`update authorizations set status = 'submitted', tx_hash = $2 where id = $1`, [id, txHash]);
      await emit('TransactionSubmitted', { tx_hash: txHash });
      break;
    }
  }
  if (!txHash) return fail('SUBMIT_FAILED', 'submitted without a tx hash', null, null);
  const confirmed = await cardano.awaitConfirmation(txHash, record.fields.valid_until + 120_000);
  if (!confirmed) return fail('NOT_CONFIRMED', 'the transaction did not confirm inside its validity window', txHash, null);
  await db.query(`update authorizations set status = 'settled' where id = $1`, [id]);
  const confirmedEvent = await emit('TransactionConfirmed', { tx_hash: txHash, block_height: confirmed.block_height });
  await markPaid(deps, id, a.invoice_id, txHash);
  const body = receiptBody(row, ctx, {
    authorization: { id, record },
    settlement: { chain: 'cardano-preprod', tx_hash: txHash, block: confirmed.block_height },
    last_event_hash: confirmedEvent.hash,
  });
  const receipt = await storeReceipt(db, { kind: 'settlement', mandateId: a.mandate_id, actionId: a.action_id, authorizationId: id, body });
  await emit('ReceiptProven', { receipt_id: receipt.id, receipt_hash: receipt.hash });
}

// Best effort: the invoice guard already refuses a second authorization for a settled invoice.
async function markPaid(deps: ExecutorDeps, id: number, invoiceId: string | null, txHash: string): Promise<void> {
  if (invoiceId === null) return;
  try {
    await deps.settle(invoiceId, txHash);
    await deps.db.query('update authorizations set stripe_marked = true where id = $1', [id]);
  } catch (error) {
    console.error(`stripe: invoice ${invoiceId} not marked paid yet: ${(error as Error).message}`);
  }
}

// One serial lane for every vault; per-vault lanes if two vaults ever need parallel releases.
export function createExecutor(deps: ExecutorDeps): Executor {
  let lane: Promise<void> = Promise.resolve();
  const executor: Executor = {
    enqueue(id) {
      lane = lane
        .then(async () => {
          await execute(deps, id);
          const [row] = await deps.db.query<{ run_id: string }>(`select run_id::text as run_id from authorizations where id = $1`, [id]);
          if (row) await completeRun(deps.db, deps.log, row.run_id);
        })
        .catch((error: unknown) => console.error(`executor: authorization ${id}: ${(error as Error).message}`));
    },
    idle: () => lane,
    async resume() {
      const rows = await deps.db.query<{ id: string }>(
        `select id::text as id from authorizations where status in ('queued', 'submitted') order by authorizations.id`,
      );
      for (const r of rows) executor.enqueue(Number(r.id));
      const unmarked = await deps.db.query<{ id: string; invoice_id: string; tx_hash: string }>(
        `select id::text as id, invoice_id, tx_hash from authorizations
         where status = 'settled' and not stripe_marked and invoice_id is not null`,
      );
      for (const u of unmarked) await markPaid(deps, Number(u.id), u.invoice_id, u.tx_hash);
    },
  };
  return executor;
}
