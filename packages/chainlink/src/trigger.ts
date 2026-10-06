import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { type ActionIR, canonicalHash, type VerifiedReport } from '@authority/core';
import type { Address, Hex, PublicClient } from 'viem';
import { readReportAtTx, verifyStoredReport } from './reader';

export interface VerificationRequest {
  action_hash: string;
  invoice_id: string;
  customer_id: string;
  requested_amount: string;
  requested_currency: string;
  requested_recipient: string;
}
export type TriggerPayload = VerificationRequest & { trigger_id: string };
export type Trigger = (payload: TriggerPayload) => Promise<string>;

export type VerificationOutcome =
  | { status: 'reported'; verified: VerifiedReport; tx_hash: Hex }
  | { status: 'unavailable'; error: string };

// Invoice facts to check come from the action; the customer comes from operator config, never the agent.
export function verificationRequestFor(action: ActionIR, customerId: string): VerificationRequest {
  const invoiceId = action.reference?.invoice_id;
  if (invoiceId === undefined) throw new Error('action has no invoice reference');
  return {
    action_hash: canonicalHash(action),
    invoice_id: invoiceId,
    customer_id: customerId,
    requested_amount: action.amount.value,
    requested_currency: 'usd',
    requested_recipient: action.recipient.address,
  };
}

// Fallback while CRE deploy access is unavailable: run the workflow in the CRE simulator.
// It still performs the real Stripe fetch and the real Sepolia write (MockKeystoneForwarder).
export function simulateBroadcast(opts: { workflowsDir: string; envFile: string; creBin?: string; timeoutMs?: number }): Trigger {
  const run = promisify(execFile);
  return async (payload) => {
    try {
      const { stdout, stderr } = await run(
        opts.creBin ?? 'cre',
        [
          'workflow', 'simulate', 'cre-verifier',
          '--target', 'sepolia-simulation',
          '--non-interactive', '--trigger-index', '0',
          '--broadcast',
          '--http-payload', JSON.stringify(payload),
          '-e', opts.envFile,
        ],
        { cwd: opts.workflowsDir, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 16 * 1024 * 1024 },
      );
      return `${stdout}\n${stderr}`;
    } catch (e) {
      // execFile's message embeds the full command line and all of stderr; keep only a short tail.
      const { code, signal, stderr } = e as { code?: unknown; signal?: unknown; stderr?: unknown };
      throw new Error(`cre simulate failed (${String(code ?? signal)}): ${String(stderr ?? '').slice(-500)}`);
    }
  };
}

// The workflow's own log line, matched as a whole line so logged data cannot inject a tx hash.
const TX_LINE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z )?\[USER LOG\] InvoiceVerified tx=(0x[0-9a-f]{64}) report_hash=[0-9a-f]{64}$/gm;

// Never returns a report the chain does not hold: the workflow output is used only to find the tx.
export async function verifyInvoice(
  req: VerificationRequest,
  deps: { trigger: Trigger; client: PublicClient; registry: Address; newTriggerId?: () => string },
): Promise<VerificationOutcome> {
  // The id is issued here and set last, so nothing in req can replace it.
  const triggerId = (deps.newTriggerId ?? randomUUID)();
  const payload: TriggerPayload = { ...req, trigger_id: triggerId };
  try {
    const output = await deps.trigger(payload);
    const txs = Array.from(output.matchAll(TX_LINE), (m) => m[1] as Hex);
    if (txs.length === 0) throw new Error('workflow output has no InvoiceVerified tx');
    if (txs.length > 1) throw new Error('workflow output has more than one InvoiceVerified tx');
    const tx = txs[0]!;
    const stored = await readReportAtTx(deps.client, deps.registry, req.action_hash, tx);
    const verified = verifyStoredReport(stored, { actionHash: req.action_hash, triggerId });
    return { status: 'reported', verified, tx_hash: tx };
  } catch (e) {
    return { status: 'unavailable', error: e instanceof Error ? e.message : String(e) };
  }
}
