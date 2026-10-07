// Prints the proof for one Task: result hash recomputed from Sokosumi's stored result, payment state, transactions,
// and the verified seller collection. Usage: pnpm --filter @authority/masumi-worker evidence <taskId>
import { join } from 'node:path';
import { createMpsClient, mip004ResultHashEscaped } from '@authority/masumi';
import { loadConfig } from '../src/config';
import { createCoreClient } from '../src/core';
import { Journal } from '../src/journal';
import { PAYMENT_COMMENT, type TaskRecord } from '../src/tasks';

const taskId = process.argv[2] ?? '';
const cfg = loadConfig(process.env);
if (!cfg.sokosumi) throw new Error('SOKOSUMI_COWORKER_ID and SOKOSUMI_COWORKER_API_KEY are required');
const rec = new Journal<TaskRecord>(join(cfg.stateDir, 'tasks')).read(taskId);
if (!rec) throw new Error(`no journal entry for task ${taskId}`);
const events = await createCoreClient({ apiKey: cfg.sokosumi.apiKey }).events(taskId);
const completed = events.find((e) => e.status === 'COMPLETED');
const out: Record<string, unknown> = {
  taskId,
  stage: rec.stage,
  paid: rec.paid,
  completionEventId: completed?.id ?? null,
  deliveredResultEqualsJournal: completed?.comment === rec.resultText,
  runningEvents: events.filter((e) => e.status === 'RUNNING').length,
  completedEvents: events.filter((e) => e.status === 'COMPLETED').length,
  paymentEvents: events.filter((e) => e.comment === PAYMENT_COMMENT).length,
};
if (rec.paid && rec.payment && rec.nonce) {
  const p = await createMpsClient({ baseUrl: cfg.paymentServiceUrl, token: cfg.paymentApiKey }).resolvePayment(rec.payment.blockchainIdentifier);
  const recomputed = typeof completed?.comment === 'string' ? mip004ResultHashEscaped(completed.comment, rec.nonce) : null;
  const listed = await fetch(`${cfg.paymentServiceUrl.replace(/\/+$/, '')}/payment?network=Preprod&limit=100&filterAgentIdentifier=${p.agentIdentifier}`, {
    headers: { token: cfg.paymentApiKey },
  });
  const payments = ((await listed.json()) as { data?: { Payments?: { inputHash: string }[] } }).data?.Payments ?? [];
  const transactions = [p.CurrentTransaction, ...(p.TransactionHistory ?? [])].flatMap((t) => {
    if (t == null || t.txHash == null) return [];
    return [{ newOnChainState: t.newOnChainState ?? null, status: t.status, txHash: t.txHash, explorer: `https://preprod.cardanoscan.io/transaction/${t.txHash}` }];
  });
  Object.assign(out, {
    paymentEventId: rec.paymentEventId ?? null,
    paymentRequestsForThisInput: payments.filter((x) => x.inputHash === rec.inputHash).length,
    blockchainIdentifier: p.blockchainIdentifier,
    identifierFromPurchaser: rec.nonce,
    inputHash: p.inputHash,
    deadlines: { payByTime: p.payByTime, submitResultTime: p.submitResultTime, unlockTime: p.unlockTime, externalDisputeUnlockTime: p.externalDisputeUnlockTime },
    onChainState: p.onChainState,
    mpsResultHash: p.resultHash,
    recomputedFromSokosumiResult: recomputed,
    resultHashMatches: recomputed !== null && recomputed === p.resultHash,
    transactions,
    settlement: rec.proof ?? null,
  });
}
console.log(JSON.stringify(out, null, 2));
