import { sha256Hex } from '@authority/core';
import {
  CollectionError,
  MpsError,
  QuoteError,
  checkQuote,
  confirmedState,
  confirmedTxHashes,
  masumiPaymentEvent,
  mip004InputHash,
  mip004ResultHashEscaped,
  paymentRequest,
  resultRecorded,
  withdrawnBy,
  type CollectionProof,
  type MpsClient,
  type Payment,
  type SellerSource,
} from '@authority/masumi';
import { AuthorityContractError, AuthorityError, buildOutput, type AuthorityClient } from './authority';
import { CoreError, type CoreClient } from './core';
import { InputError, parseTaskDescription, type AuthorityRequest } from './input';
import type { Log } from './jobs';
import { holdGeneration, type Journal } from './journal';

const MINUTE = 60_000;
const CREATE_ATTEMPTS = 8;
const RETRY_BACKOFF_MS = 0;
const TERMINAL_PAYMENT = new Set(['FundsOrDatumInvalid', 'RefundRequested']);
export const PAYMENT_COMMENT = 'Payment requested: 1 tUSDM for one human authority check.';

export type TaskStage =
  | 'start-pending'
  | 'started'
  | 'quote-pending'
  | 'quote-saved'
  | 'payment-event-pending'
  | 'awaiting-funds'
  | 'authority-pending'
  | 'result-saved'
  | 'submit-pending'
  | 'complete-pending'
  | 'collection-pending'
  | 'settled'
  | 'completed'
  | 'failed'
  | 'needs-inspection';

export const TERMINAL: ReadonlySet<TaskStage> = new Set(['settled', 'completed', 'failed', 'needs-inspection']);

export interface TaskRecord {
  taskId: string;
  stage: TaskStage;
  paid: boolean;
  name?: string;
  description?: string | null;
  request?: AuthorityRequest;
  nonce?: string;
  inputHash?: string;
  payment?: Payment;
  paymentEventId?: string;
  resultText?: string;
  resultHash?: string;
  completionEventId?: string;
  proof?: CollectionProof;
  error?: string;
  retryNotBefore?: number;
  // Set only after a 408/429, which the payment service did not process. Any other quote-pending
  // record is an unknown outcome and must not create a second payment.
  createRetryable?: boolean;
}

export interface TaskDeps {
  tasks: Journal<TaskRecord>;
  core: CoreClient;
  mps: MpsClient;
  authority: AuthorityClient;
  source: SellerSource | null;
  coworkerId: string;
  paid: boolean;
  webUrl: string;
  // inputHash and the payment's confirmed tx hashes bind the collection to this purchase.
  verifyCollection: (
    txHash: string,
    sellerAddress: string,
    binding: { inputHash: string; paymentTxHashes: readonly string[] },
  ) => Promise<CollectionProof>;
  now: () => number;
  log: Log;
  // Generation captured after the executor acquired the lease. Null is not a hold. createPayment,
  // the authority check, and submit-result are refused if holdGeneration(leaseDir) no longer matches.
  leaseDir: string;
  generation: string | null;
  wait?: (ms: number) => Promise<void>;
}

// identifierFromPurchaser for a Task is derived from the Task id, so every retry uses the same one.
export function taskNonce(taskId: string): string {
  return sha256Hex(`sokosumi-task:${taskId}`).slice(0, 20);
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`journal is missing ${what}`);
  return value;
}

const waitFor = (deps: TaskDeps, ms: number): Promise<void> => (deps.wait ?? ((n) => new Promise((r) => setTimeout(r, n))))(ms);

const lostHold = (deps: TaskDeps): boolean => deps.generation === null || holdGeneration(deps.leaseDir) !== deps.generation;

// 408/429 were not processed and may be retried. 5xx, a 2xx without the success envelope, and a
// timeout or reset after the bytes were sent may have created a payment: never retry those.
function classifyCreate(e: unknown): 'retry' | 'failed' | 'needs-inspection' {
  if (e instanceof MpsError) {
    if (e.status === 408 || e.status === 429) return 'retry';
    if (e.uncertain) return 'needs-inspection';
    return 'failed';
  }
  return 'needs-inspection';
}

export async function pollTasks(deps: TaskDeps): Promise<void> {
  for (const t of await deps.core.readyTasks()) {
    if (t.assigneeId !== deps.coworkerId || deps.tasks.read(t.id)) continue;
    if (deps.paid && deps.source === null) {
      deps.log('paid tasks need a confirmed registration; task left READY', { taskId: t.id });
      continue;
    }
    deps.tasks.write(t.id, { taskId: t.id, stage: 'start-pending', paid: deps.paid });
  }
  for (const key of deps.tasks.keys()) {
    const rec = deps.tasks.read(key);
    if (!rec || TERMINAL.has(rec.stage)) continue;
    try {
      await advanceTask(rec, deps);
    } catch (e) {
      deps.log('task step failed; retrying next poll', { taskId: rec.taskId, stage: rec.stage, error: String(e) });
    }
  }
}

// One step-loop per Task. Each stage is journaled before the external call it guards. Calls that could
// charge twice (quote, payment event) are never repeated blindly; status changes and the result submission
// re-read state first.
export async function advanceTask(start: TaskRecord, deps: TaskDeps): Promise<TaskRecord> {
  let rec = start;
  const save = (patch: Partial<TaskRecord>): void => {
    rec = { ...rec, ...patch };
    deps.tasks.write(rec.taskId, rec);
  };
  const inspect = (error: string): TaskRecord => {
    save({ stage: 'needs-inspection', error, createRetryable: false });
    deps.log('task needs inspection', { taskId: rec.taskId, error });
    return rec;
  };
  const fail = async (reason: string): Promise<TaskRecord> => {
    if ((await deps.core.getTask(rec.taskId)).status !== 'FAILED') {
      if (lostHold(deps)) return inspect('lease generation changed before FAILED');
      await deps.core.postEvent(rec.taskId, { status: 'FAILED', comment: reason });
    }
    save({ stage: 'failed', error: reason, createRetryable: false });
    deps.log('task failed', { taskId: rec.taskId, reason });
    return rec;
  };
  const source = (): SellerSource => need(deps.source, 'a confirmed registration');

  // quote-pending is already on disk. Returns 'stop' when this call must not continue.
  const requestPayment = async (): Promise<'stop' | 'continue'> => {
    const quoteRequest = paymentRequest(source(), need(rec.inputHash, 'input hash'), need(rec.nonce, 'nonce'), deps.now());
    let payment: Payment | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      if (lostHold(deps)) {
        inspect('lease generation changed before the payment request');
        return 'stop';
      }
      try {
        payment = await deps.mps.createPayment(quoteRequest);
        checkQuote(payment, source(), quoteRequest);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        payment = undefined;
        if (e instanceof QuoteError) break;
        if (classifyCreate(e) === 'retry') {
          await waitFor(deps, RETRY_BACKOFF_MS);
          continue;
        }
        break;
      }
    }
    if (!payment) {
      if (lastErr instanceof QuoteError) {
        inspect(lastErr.message);
        return 'stop';
      }
      const kind = classifyCreate(lastErr);
      if (kind === 'retry') {
        save({ createRetryable: true, error: String(lastErr) });
        deps.log('payment request retryable', { taskId: rec.taskId, error: String(lastErr) });
        return 'stop';
      }
      if (kind === 'failed') {
        const status = lastErr instanceof MpsError ? lastErr.status : 0;
        await fail(`Payment service rejected the payment request (HTTP ${status})`);
        return 'stop';
      }
      inspect(String(lastErr));
      return 'stop';
    }
    save({ stage: 'quote-saved', payment, createRetryable: false });
    return 'continue';
  };

  for (;;) {
    switch (rec.stage) {
      case 'start-pending': {
        const task = await deps.core.getTask(rec.taskId);
        if (task.assigneeId !== deps.coworkerId) return inspect('task is not assigned to this coworker');
        if (task.status === 'GRANT_PENDING') return rec; // waits for the Workspace owner to approve Vendor access
        if (task.status === 'READY') {
          if (lostHold(deps)) return inspect('lease generation changed before RUNNING');
          await deps.core.postEvent(rec.taskId, { status: 'RUNNING' });
        } else if (task.status !== 'RUNNING') return inspect(`unexpected task status ${task.status}`);
        save({ stage: 'started', name: task.name, description: task.description });
        continue;
      }
      case 'started': {
        let request: AuthorityRequest;
        try {
          request = parseTaskDescription(rec.description ?? null);
        } catch (e) {
          if (e instanceof InputError) return fail(`Invalid input: ${e.message}`);
          throw e;
        }
        if (!rec.paid) {
          save({ stage: 'authority-pending', request });
          continue;
        }
        const nonce = taskNonce(rec.taskId);
        const inputHash = mip004InputHash({ taskId: rec.taskId, name: rec.name ?? '', description: rec.description ?? null }, nonce);
        save({ stage: 'quote-pending', request, nonce, inputHash, createRetryable: false });
        if ((await requestPayment()) === 'stop') return rec;
        continue;
      }
      case 'quote-pending':
        if (!rec.createRetryable) return inspect('payment request outcome unknown after a restart');
        if ((await requestPayment()) === 'stop') return rec;
        continue;
      case 'quote-saved': {
        const payment = need(rec.payment, 'payment');
        if (deps.now() >= Number(payment.payByTime) - MINUTE) return fail('Signed payment terms expired before the payment request');
        save({ stage: 'payment-event-pending' });
        if (lostHold(deps)) return inspect('lease generation changed before the payment event');
        let event: { id: string };
        try {
          event = await deps.core.postEvent(rec.taskId, {
            comment: PAYMENT_COMMENT,
            masumiPayment: masumiPaymentEvent(payment, need(rec.nonce, 'nonce'), source()),
          });
        } catch (e) {
          if (e instanceof CoreError && e.status >= 400 && e.status < 500) return fail(`Sokosumi rejected the payment request (HTTP ${e.status})`);
          throw e;
        }
        save({ stage: 'awaiting-funds', paymentEventId: event.id });
        deps.log('payment requested', { taskId: rec.taskId, blockchainIdentifier: payment.blockchainIdentifier, eventId: event.id });
        continue;
      }
      case 'payment-event-pending': {
        const payment = need(rec.payment, 'payment');
        const receipt = await deps.core.receipt(rec.taskId);
        if (receipt.blockchainIdentifier?.toLowerCase() !== payment.blockchainIdentifier.toLowerCase()) {
          return inspect('payment event outcome unknown and Core shows no matching payment claim');
        }
        save({ stage: 'awaiting-funds' });
        continue;
      }
      case 'awaiting-funds': {
        const payment = need(rec.payment, 'payment');
        const p = await deps.mps.resolvePayment(payment.blockchainIdentifier);
        if (p.onChainState !== null && TERMINAL_PAYMENT.has(p.onChainState)) {
          return fail(`payment ended in ${p.onChainState}`);
        }
        if (!confirmedState(p, 'FundsLocked')) {
          if (deps.now() > Number(payment.payByTime) + 10 * MINUTE && p.onChainState === null) {
            return fail('Payment was not locked before the deadline; nothing was charged on-chain');
          }
          return rec;
        }
        save({ stage: 'authority-pending' });
        continue;
      }
      case 'authority-pending': {
        if (rec.retryNotBefore !== undefined && deps.now() < rec.retryNotBefore) return rec;
        const submitBy = rec.paid ? Number(need(rec.payment, 'payment').submitResultTime) : undefined;
        if (submitBy !== undefined && deps.now() >= submitBy - 2 * MINUTE) {
          return fail('Result deadline reached before the check ran; the escrow refunds the buyer');
        }
        if (lostHold(deps)) return inspect('lease generation changed before the authority check');
        let resultText: string;
        try {
          const checked = await deps.authority.check(
            need(rec.request, 'request'),
            `sokosumi:${rec.taskId}`,
            submitBy === undefined ? undefined : { deadlineMs: submitBy },
          );
          resultText = buildOutput(checked, deps.webUrl).resultText;
        } catch (e) {
          if (e instanceof AuthorityContractError || (e instanceof AuthorityError && !e.transient)) {
            return fail(`Authority check failed: ${e.message}`);
          }
          if (e instanceof AuthorityError && e.transient) {
            const delay = Math.max(e.retryAfterMs ?? 0, RETRY_BACKOFF_MS);
            if (delay > 0) save({ retryNotBefore: deps.now() + delay });
            deps.log('task step failed; retrying next poll', { taskId: rec.taskId, stage: rec.stage, error: String(e) });
            return rec;
          }
          throw e;
        }
        save({
          stage: 'result-saved',
          resultText,
          ...(rec.paid ? { resultHash: mip004ResultHashEscaped(resultText, need(rec.nonce, 'nonce')) } : {}),
        });
        continue;
      }
      case 'result-saved':
        save({ stage: rec.paid ? 'submit-pending' : 'complete-pending' });
        continue;
      case 'submit-pending': {
        const payment = need(rec.payment, 'payment');
        const hash = need(rec.resultHash, 'result hash');
        const current = await deps.mps.resolvePayment(payment.blockchainIdentifier);
        if (!resultRecorded(current, hash)) {
          if (current.resultHash) return inspect('payment already carries a different result hash');
          if (deps.now() + 2 * MINUTE >= Number(payment.submitResultTime)) {
            return fail('Result deadline passed before submission; the escrow refunds the buyer');
          }
          if (lostHold(deps)) return inspect('lease generation changed before submit-result');
          await deps.mps.submitResult(payment.blockchainIdentifier, hash);
        }
        save({ stage: 'complete-pending' });
        continue;
      }
      case 'complete-pending': {
        const task = await deps.core.getTask(rec.taskId);
        if (task.status === 'RUNNING') {
          if (lostHold(deps)) return inspect('lease generation changed before COMPLETED');
          const event = await deps.core.postEvent(rec.taskId, { status: 'COMPLETED', comment: need(rec.resultText, 'result') });
          save({ completionEventId: event.id });
        } else if (task.status !== 'COMPLETED') {
          return inspect(`unexpected task status ${task.status}`);
        }
        save({ stage: rec.paid ? 'collection-pending' : 'completed' });
        deps.log('task completed', { taskId: rec.taskId, paid: rec.paid, resultHash: rec.resultHash ?? null });
        continue;
      }
      case 'collection-pending': {
        const payment = need(rec.payment, 'payment');
        const receipt = await deps.core.receipt(rec.taskId);
        if (!receipt.settled || !receipt.txHash) return rec;
        if (receipt.blockchainIdentifier?.toLowerCase() !== payment.blockchainIdentifier.toLowerCase()) {
          return inspect('Core receipt belongs to another payment');
        }
        const resolved = await deps.mps.resolvePayment(payment.blockchainIdentifier);
        if (!withdrawnBy(resolved, receipt.txHash)) return rec;
        let proof: CollectionProof;
        try {
          proof = await deps.verifyCollection(receipt.txHash, source().sellerAddress, {
            inputHash: payment.inputHash,
            paymentTxHashes: confirmedTxHashes(resolved),
          });
        } catch (e) {
          if (e instanceof CollectionError) return inspect(e.message);
          throw e;
        }
        save({ stage: 'settled', proof });
        deps.log('seller collection verified', { taskId: rec.taskId, ...proof });
        return rec;
      }
      default:
        return rec;
    }
  }
}
