import { parseShelleyAddress } from './address';
import { ACTION_TYPE_CODE, type AuthorizationRecord, signAuthorization } from './authorization';
import type { Evaluation } from './engine';
import { canonicalHash } from './hash';
import { enforcementLimits, mandateHash } from './mandate';
import type { ActionIR, Mandate } from './schemas';

export const AUTHORIZATION_TTL_MS = 600_000;
export const EVALUATION_MAX_AGE_MS = 60_000;

export type IssuanceRefusal =
  | 'UNSIGNED_PROPOSAL'
  | 'NOT_AUTHORIZABLE'
  | 'APPROVAL_MISSING'
  | 'STALE_EVALUATION'
  | 'ACTION_MISMATCH'
  | 'MANDATE_MISMATCH'
  | 'ABOVE_HARD_CAP'
  | 'ASSET_MISMATCH'
  | 'UNSUPPORTED_ACTION_TYPE'
  | 'MANDATE_EXPIRED'
  | 'RECIPIENT_UNENCODABLE'
  | 'INVALID_NONCE';

export class IssuanceRefused extends Error {
  constructor(readonly code: IssuanceRefusal) {
    super(`authorization refused: ${code}`);
  }
}

export interface ChainBinding {
  chainTag: 0 | 1;
  vaultHash: string;
  mandateRef: string;
  assetPolicy: string;
  assetName: string;
  assetSymbol: string;
}

export interface IssueInput {
  evaluation: Evaluation;
  action: ActionIR;
  mandate: Mandate;
  approval: { approver: string; approved_at_ms: number } | null;
  chain: ChainBinding;
  nonce: bigint;
  nowMs: number;
  engineSecretKey: Uint8Array;
}

function refuse(code: IssuanceRefusal): never {
  throw new IssuanceRefused(code);
}

// Fails closed: NaN, non-integer, future, or older than EVALUATION_MAX_AGE_MS is not fresh.
function fresh(atMs: number, nowMs: number): boolean {
  const age = nowMs - atMs;
  return Number.isSafeInteger(atMs) && age >= 0 && age <= EVALUATION_MAX_AGE_MS;
}

export function issueAuthorization(input: IssueInput): AuthorizationRecord {
  const { evaluation: e, action, mandate, chain, nowMs } = input;
  if (!Number.isSafeInteger(nowMs)) throw new TypeError('issueAuthorization: nowMs must be a safe integer');
  if (!e.signed) refuse('UNSIGNED_PROPOSAL');
  const actionHash = canonicalHash(action);
  if (e.action_hash !== actionHash) refuse('ACTION_MISMATCH');
  if (e.mandate_hash !== mandateHash(mandate) || e.mandate_version !== mandate.version) refuse('MANDATE_MISMATCH');
  if (!fresh(e.evaluated_at_ms, nowMs)) refuse('STALE_EVALUATION');

  const amount = BigInt(action.amount.value);
  const { autonomous, hardCap } = enforcementLimits(mandate);
  let requiresPrincipal = false;
  if (e.outcome === 'REQUIRE_APPROVAL') {
    const approval = input.approval;
    if (
      approval === null ||
      e.approvals_required.length === 0 ||
      !fresh(approval.approved_at_ms, nowMs) ||
      !e.approvals_required.every((a) => a.approver === approval.approver)
    ) {
      refuse('APPROVAL_MISSING');
    }
    requiresPrincipal = true;
  } else if (e.outcome !== 'ALLOW' || autonomous === null || amount > autonomous) {
    // An ALLOW above the autonomous limit cannot come from evaluate(); refuse rather than sign without the principal flag.
    refuse('NOT_AUTHORIZABLE');
  }

  if (hardCap === null || amount > hardCap) refuse('ABOVE_HARD_CAP');
  if (action.amount.asset !== mandate.asset.symbol || chain.assetSymbol !== mandate.asset.symbol) refuse('ASSET_MISMATCH');
  if (action.type !== 'pay_invoice') refuse('UNSUPPORTED_ACTION_TYPE');
  if (input.nonce < 1n) refuse('INVALID_NONCE');

  try {
    if (parseShelleyAddress(action.recipient.address).network !== chain.chainTag) refuse('RECIPIENT_UNENCODABLE');
  } catch (error) {
    if (error instanceof IssuanceRefused) throw error;
    refuse('RECIPIENT_UNENCODABLE');
  }

  const expiresAt = BigInt(Date.parse(mandate.validity.expires_at));
  const ttlEnd = BigInt(nowMs) + BigInt(AUTHORIZATION_TTL_MS);
  const validUntil = ttlEnd < expiresAt ? ttlEnd : expiresAt;
  if (validUntil <= BigInt(nowMs)) refuse('MANDATE_EXPIRED');

  return signAuthorization(
    {
      chainTag: chain.chainTag,
      vaultHash: chain.vaultHash,
      mandateRef: chain.mandateRef,
      mandateHash: e.mandate_hash,
      mandateVersion: mandate.version,
      actionHash,
      actionType: ACTION_TYPE_CODE.pay_invoice,
      assetPolicy: chain.assetPolicy,
      assetName: chain.assetName,
      amount,
      recipient: action.recipient.address,
      nonce: input.nonce,
      validUntil,
      requiresPrincipal,
      verificationRef: e.verification_hash,
    },
    input.engineSecretKey,
  );
}
