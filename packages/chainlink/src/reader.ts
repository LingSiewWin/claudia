import { canonicalHash, VerificationReportSchema, type VerifiedReport } from '@authority/core';
import { type Address, type Hex, parseEventLogs, type PublicClient } from 'viem';
import { REGISTRY_ABI, reportFromStored, resultFromFacts, type StoredFields } from './codec';

export interface StoredReport {
  reportHash: Hex;
  fields: StoredFields;
  blockTime: bigint;
}

// The engine trusts a report only after rebuilding it from the stored fields and checking
// schema, hash, internal consistency, action, and the trigger it asked for.
export function verifyStoredReport(stored: StoredReport, expected: { actionHash: string; triggerId: string }): VerifiedReport {
  const report = reportFromStored(stored.fields);
  if (!VerificationReportSchema.safeParse(report).success) throw new Error('stored report fails schema');
  const reportHash = stored.reportHash.slice(2).toLowerCase();
  if (canonicalHash(report) !== reportHash) throw new Error('report hash mismatch');
  const derived = resultFromFacts(report.facts);
  if (derived.result !== report.result || derived.reason !== report.reason) throw new Error('result inconsistent with facts');
  if (report.action_hash !== expected.actionHash) throw new Error('report is for another action');
  if (report.trigger_id !== expected.triggerId) throw new Error('report is for another trigger');
  return { report, report_hash: reportHash, block_time_ms: Number(stored.blockTime) * 1000 };
}

// Reads latestReport(actionHash) at the block of the write transaction, after checking that
// the transaction succeeded and emitted InvoiceVerified for this action from the registry.
export async function readReportAtTx(
  client: PublicClient,
  registry: Address,
  actionHash: string,
  txHash: Hex,
): Promise<StoredReport> {
  // 2 confirmations guard against a shallow reorg; finality (~16 min) would exceed the 600 s freshness window.
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: 2, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`tx ${txHash} reverted`);
  const events = parseEventLogs({ abi: REGISTRY_ABI, eventName: 'InvoiceVerified', logs: receipt.logs }).filter(
    (e) => e.address.toLowerCase() === registry.toLowerCase() && e.args.actionHash === `0x${actionHash}`,
  );
  if (events.length !== 1) throw new Error(`tx ${txHash} has ${events.length} InvoiceVerified events for this action`);
  const [reportHash, stored] = await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'latestReport',
    args: [`0x${actionHash}`],
    blockNumber: receipt.blockNumber,
  });
  if (reportHash !== events[0]!.args.reportHash) throw new Error('latest report differs from the emitted one');
  return { reportHash, fields: stored.fields, blockTime: stored.blockTime };
}
