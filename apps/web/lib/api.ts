import { config } from './config';
import type {
  ApprovalView,
  AttackId,
  AuthorityInfo,
  DeclineSignature,
  LogAnchorRef,
  MandateView,
  Metrics,
  ReceiptBundle,
  ReceiptSummary,
  RunEvent,
  RunKind,
  RunSummary,
} from './contract';
import type { AuthorizationRecord } from '@authority/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(`${config.apiBase}${path}`, init);
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return json as T;
}

const id = encodeURIComponent;

export const listRuns = (kind: RunKind | 'all') => call<{ runs: RunSummary[] }>(`/v1/runs?kind=${kind}`);
export const runLog = (runId: string) =>
  call<{ run: RunSummary; events: RunEvent[]; anchor?: LogAnchorRef | null }>(`/v1/runs/${id(runId)}/log`);
export const startRun = (mandateId: string) => call<{ run_id: string }>('/v1/runs', { mandate_id: mandateId });
export const eventsUrl = (runId: string) => `${config.apiBase}/v1/runs/${id(runId)}/events`;
export const startAttack = (attack: AttackId) => call<{ run_id: string }>('/v1/lab/attacks', { attack });
export const getMandate = (mandateId: string) => call<MandateView>(`/v1/mandates/${id(mandateId)}`);
export const pendingApprovals = () => call<{ approvals: ApprovalView[] }>('/v1/approvals?status=pending');
export const approve = (approvalId: string) =>
  call<{ authorization: AuthorizationRecord; unsigned_tx_cbor: string; tx_hash: string }>(
    `/v1/approvals/${id(approvalId)}/approve`,
    {},
  );
/** Decline returns the bond spend (refund or capture) for the approver wallet to sign; bondSubmit sends it. */
export const decline = (approvalId: string, cfo: DeclineSignature) =>
  call<{ unsigned_tx_cbor: string; tx_hash: string }>(`/v1/approvals/${id(approvalId)}/decline`, cfo);
export const bondSubmit = (approvalId: string, body: { tx_hash: string; cfo_witness_cbor: string }) =>
  call<{ tx_hash: string }>(`/v1/approvals/${id(approvalId)}/bond-submit`, body);
export const getAuthority = (role: string, mandateId: string) =>
  call<AuthorityInfo>(`/v1/authority/${id(role)}?mandate_id=${id(mandateId)}`);
export const getMetrics = (mandateId: string) => call<Metrics>(`/v1/metrics?mandate_id=${id(mandateId)}`);
export const execute = (body: { approval_id: string; authorization_digest: string; cfo_witness_cbor: string }) =>
  call<{ run_id: string; tx_hash: string }>('/v1/executions', body);
export const prepareRevoke = (mandateId: string) =>
  call<{ unsigned_tx_cbor: string; tx_hash: string; version: number }>(`/v1/mandates/${id(mandateId)}/revoke`, {});
export const prepareUpdate = (
  mandateId: string,
  limits: { autonomous_limit: string; hard_cap: string; daily_cap: string; treasury_minimum: string },
) => call<{ unsigned_tx_cbor: string; tx_hash: string; version: number }>(`/v1/mandates/${id(mandateId)}/update`, { limits });
export const submitMandateTx = (mandateId: string, body: { tx_hash: string; cfo_witness_cbor: string }) =>
  call<{ tx_hash: string }>(`/v1/mandates/${id(mandateId)}/submit`, body);
export const listReceipts = (mandateId: string) =>
  call<{ receipts: ReceiptSummary[] }>(`/v1/receipts?mandate_id=${id(mandateId)}`);
export const getReceipt = (receiptId: string) => call<ReceiptBundle>(`/v1/receipts/${id(receiptId)}`);
