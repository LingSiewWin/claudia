import { parseShelleyAddress } from './address';
import { ACTION_TYPE_CODE, type AuthorizationRecord, signAuthorization } from './authorization';
import { type EvaluateInput, evaluate } from './engine';
import { canonicalHash } from './hash';
import { enforcementLimits } from './mandate';
import { ActionIRSchema } from './schemas';

export const AUTHORIZATION_TTL_MS = 600_000;
export const APPROVAL_MAX_AGE_MS = 60_000;

export type IssuanceRefusal =
  | 'UNSIGNED_PROPOSAL'
  | 'NOT_AUTHORIZABLE'
  | 'APPROVAL_MISSING'
  | 'ABOVE_HARD_CAP'
  | 'ASSET_MISMATCH'
  | 'UNSUPPORTED_ACTION_TYPE'
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

export interface Approval {
  approver: string;
  approved_at_ms: number;
}

/*
 * issueAuthorization({ mandate, proposal, state, verification, nowMs, approval, chain, nonce, engineSecretKey })
 *
 * The only public signing path. It takes evaluate()'s inputs, never an Evaluation: it runs evaluate() itself
 * at nowMs, so report freshness is measured at signing time, and signs only what that evaluation allows.
 * ALLOW signs with requires_principal = 0. REQUIRE_APPROVAL needs a fresh approval from the mandate's approver
 * and signs with requires_principal = 1. Everything else throws IssuanceRefused.
 */
export interface IssueInput extends EvaluateInput {
  approval: Approval | null;
  chain: ChainBinding;
  nonce: bigint;
  engineSecretKey: Uint8Array;
}

function refuse(code: IssuanceRefusal): never {
  throw new IssuanceRefused(code);
}

// Fails closed: NaN, non-integer, future, or older than APPROVAL_MAX_AGE_MS is not fresh.
function fresh(atMs: number, nowMs: number): boolean {
  const age = nowMs - atMs;
  return Number.isSafeInteger(atMs) && age >= 0 && age <= APPROVAL_MAX_AGE_MS;
}

export function issueAuthorization(input: IssueInput): AuthorizationRecord {
  const { mandate, chain, nowMs } = input;
  // Parse once and evaluate that copy, so the signed bytes come from exactly the action that was evaluated.
  const parsed = ActionIRSchema.safeParse(input.proposal.action);
  if (!parsed.success) refuse('NOT_AUTHORIZABLE');
  const action = parsed.data;
  const proposal = { action, agent_signature: input.proposal.agent_signature };
  const e = evaluate({ mandate, proposal, state: input.state, verification: input.verification, nowMs });
  if (!e.signed) refuse('UNSIGNED_PROPOSAL');

  const amount = BigInt(action.amount.value);
  const { autonomous, hardCap } = enforcementLimits(mandate);
  let requiresPrincipal = false;
  if (e.outcome === 'REQUIRE_APPROVAL') {
    const approval = input.approval;
    if (approval === null || !fresh(approval.approved_at_ms, nowMs) || !e.approvals_required.every((a) => a.approver === approval.approver)) {
      refuse('APPROVAL_MISSING');
    }
    requiresPrincipal = true;
  } else if (e.outcome !== 'ALLOW' || autonomous === null || amount > autonomous) {
    // An ALLOW without or above an autonomous limit only comes from a mandate that skipped parseMandate.
    refuse('NOT_AUTHORIZABLE');
  }

  // Defense in depth: the vault re-checks these too.
  if (hardCap === null || amount > hardCap) refuse('ABOVE_HARD_CAP');
  if (action.amount.asset !== mandate.asset.symbol || chain.assetSymbol !== mandate.asset.symbol) refuse('ASSET_MISMATCH');
  if (action.type !== 'pay_invoice') refuse('UNSUPPORTED_ACTION_TYPE');
  if (input.nonce < 1n) refuse('INVALID_NONCE');
  if (parseShelleyAddress(action.recipient.address).network !== chain.chainTag) refuse('RECIPIENT_UNENCODABLE');

  // evaluate() denies unless nowMs < expires_at, so validUntil > nowMs.
  const expiresAt = BigInt(Date.parse(mandate.validity.expires_at));
  const ttlEnd = BigInt(nowMs) + BigInt(AUTHORIZATION_TTL_MS);
  const validUntil = ttlEnd < expiresAt ? ttlEnd : expiresAt;

  return signAuthorization(
    {
      chainTag: chain.chainTag,
      vaultHash: chain.vaultHash,
      mandateRef: chain.mandateRef,
      mandateHash: e.mandate_hash,
      mandateVersion: mandate.version,
      actionHash: canonicalHash(action),
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
