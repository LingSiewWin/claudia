import { readFileSync } from 'node:fs';
import type { EthReceipt, KoiosTx } from '../lib/chain';
import type { ApprovalView, MandateView, ReceiptBundle, RunEvent, RunSummary } from '../lib/contract';

export interface Recorded {
  registry: string;
  runs: RunSummary[];
  logs: Record<string, RunEvent[]>;
  mandates: Record<string, MandateView>;
  approvals: ApprovalView[];
  bundles: Record<string, ReceiptBundle>;
  koios: Record<string, KoiosTx>;
  sepolia: Record<string, EthReceipt>;
}

export const recorded: Recorded = JSON.parse(readFileSync(new URL('../fixtures/recorded.json', import.meta.url), 'utf8'));
export const stage = (): RunEvent[] => structuredClone(recorded.logs['run-stage-0001'] ?? []);
export const bundle = (id = 'R-0001'): ReceiptBundle => structuredClone(recorded.bundles[id] as ReceiptBundle);
