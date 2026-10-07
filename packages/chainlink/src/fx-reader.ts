import { canonicalHash } from '@authority/core';
import type { Address, Hex, PublicClient } from 'viem';
import { FX_REGISTRY_ABI, type FxBasisReport, fxReportFromStored } from './fx-codec';

export interface FxReadback {
  report: FxBasisReport;
  report_hash: string;
  block_time_ms: number;
}

// Rebuilds the report from the stored fields and recomputes the key; the stored key is never trusted.
export async function readFxBasis(client: PublicClient, registry: Address, reportHash: string): Promise<FxReadback> {
  const key = reportHash.toLowerCase().replace(/^0x/, '');
  const stored = await client.readContract({
    address: registry,
    abi: FX_REGISTRY_ABI,
    functionName: 'getReport',
    args: [`0x${key}` as Hex],
  });
  const report = fxReportFromStored(stored.fields);
  const recomputed = canonicalHash(report);
  if (recomputed !== key) throw new Error(`report hash mismatch: stored ${key}, recomputed ${recomputed}`);
  return { report, report_hash: recomputed, block_time_ms: Number(stored.blockTime) * 1000 };
}
