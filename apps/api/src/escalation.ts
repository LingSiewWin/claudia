import {
  type ActionIR,
  type Bond,
  BondSchema,
  buildBrief,
  canonicalJson,
  DAY_MS,
  type DecisionBrief,
  type EscalationPrice,
  EscalationPriceSchema,
  type Evaluation,
  type State,
  type AnyVerificationReport,
  bytesToHex,
  parseShelleyAddress,
} from '@authority/core';
import { bondDatumCbor } from '@authority/cardano';
import type { Sql } from '@authority/db';
import * as z from 'zod';
import type { Reply } from './http';
import type { MandateRow } from './mandates';
import type { BondUtxo, CardanoPort } from './ports';

/*
 * x402 escalation: an ESCALATE that wants execution is priced before any human sees it. The price is a bond the
 * agent locks in the escrow validator; the interrupt budget counts only escalations whose bond was locked.
 * Transport per coinbase/x402 transports-v2/http: PAYMENT-REQUIRED (402 reply), PAYMENT-SIGNATURE (retry),
 * PAYMENT-RESPONSE (settled 200), each a base64 JSON document.
 *
 * Two accepts entries describe the same lock. `cardano-escrow` (ours): the agent submits the lock itself and proves
 * it with the UTxO reference. `exact` on `cardano:preprod` (x402 scheme_exact_cardano, assetTransferMethod
 * `script`): the client signs the lock tx but does not broadcast it; the API submits it (itself or through an x402
 * facilitator) and then reads the escrow UTxO back exactly as for the first entry. The bond datum names the payer's
 * refund keys: a check that sends `bond_refund_address` gets the complete inline datum in `extra.datum` (a standard
 * client attaches it verbatim); otherwise `extra.escalation` carries the price and the client builds the
 * escalation_bond datum itself (packages/cardano bondDatumFor).
 */

export const BOND_LOCK_MS = 3_600_000;
export const BOND_ASSET = 'ADA';

/** Escalations that consumed human attention (bond locked) under this mandate on this UTC day, except `excludeId`. */
export async function escalationsToday(q: Sql, mandateId: string, dayIndex: number, excludeId: number | null = null): Promise<number> {
  const [row] = await q.query<{ n: number }>(
    `select count(*)::int as n from approvals where mandate_id = $1 and day_index = $2 and status <> 'awaiting_bond' and id <> $3`,
    [mandateId, dayIndex, excludeId ?? -1],
  );
  return row?.n ?? 0;
}

/** The engine's State with the interrupt budget read from the approvals table (the engine never counts itself). */
export async function withBudget(q: Sql, mandateId: string, state: State, nowMs: number, excludeId: number | null = null): Promise<State> {
  const day = Math.floor(nowMs / DAY_MS);
  return { ...state, escalations_today: await escalationsToday(q, mandateId, day, excludeId), escalation_day_index: day };
}

export function priceFor(
  eng: { bondLovelace: string; cardano: Pick<CardanoPort, 'bondAddresses'>; now: () => number },
  row: MandateRow,
  o: { approvalId: string; actionHash: string; approverPkh: string; used: number },
): EscalationPrice {
  return EscalationPriceSchema.parse({
    schema: 'escalation-price/v0.1',
    approval_id: o.approvalId,
    network: row.binding.chainTag === 1 ? 'cardano-mainnet' : 'cardano-preprod',
    asset: { policy_id: '', asset_name: '', symbol: BOND_ASSET },
    amount: eng.bondLovelace,
    escrow_address: eng.cardano.bondAddresses().escrow,
    action_hash: o.actionHash,
    approver_key_hash: o.approverPkh,
    locked_until_ms: eng.now() + BOND_LOCK_MS,
    interrupt_budget: { used: o.used, per_day: row.mandate.interrupt_budget.per_day },
  });
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

/** x402 network id of the price network: cardano-preprod -> cardano:preprod. */
export const x402Network = (network: EscalationPrice['network']) => network.replace('-', ':');
const assetUnit = (price: EscalationPrice) => (price.asset.policy_id === '' ? 'lovelace' : `${price.asset.policy_id}.${price.asset.asset_name}`);

/** The standard entry: exact scheme, script transfer method, the escrow validator declared by its hash. */
export function exactRequirements(price: EscalationPrice, refundAddress?: string) {
  return {
    scheme: 'exact',
    network: x402Network(price.network),
    amount: price.amount,
    asset: assetUnit(price),
    payTo: price.escrow_address,
    maxTimeoutSeconds: BOND_LOCK_MS / 1000,
    extra: {
      assetTransferMethod: 'script',
      scriptHash: bytesToHex(parseShelleyAddress(price.escrow_address).payment.hash),
      confirmationPolicy: { l1Confirmations: 0 },
      ...(refundAddress === undefined ? {} : { datum: bondDatumCbor(price, refundAddress) }),
      escalation: price,
    },
  };
}

export function paymentRequired(publicApiUrl: string, price: EscalationPrice, actionId: string, refundAddress?: string) {
  return {
    x402Version: 2,
    error: 'escalation requires a bond',
    resource: { url: `${publicApiUrl}/v1/authority/check`, description: `Human authority for action ${actionId}` },
    accepts: [
      {
        scheme: 'cardano-escrow',
        network: price.network,
        amount: price.amount,
        asset: assetUnit(price),
        payTo: price.escrow_address,
        maxTimeoutSeconds: BOND_LOCK_MS / 1000,
        extra: price,
      },
      exactRequirements(price, refundAddress),
    ],
  };
}

/** 402: header and body carry the same PaymentRequired document. */
export function reply402(publicApiUrl: string, price: EscalationPrice, actionId: string, refundAddress?: string): Reply {
  const body = paymentRequired(publicApiUrl, price, actionId, refundAddress);
  return { status: 402, body, headers: { 'payment-required': b64(body) } };
}

export const paymentResponse = (network: string, txHash: string) => b64({ success: true, network, transaction: txHash });

const ApprovalId = z.string().min(1).max(64);
/** Our entry: the lock the agent already submitted. */
const EscrowPayloadSchema = z.object({
  x402Version: z.literal(2),
  accepted: z.unknown(),
  payload: z.strictObject({ approval_id: ApprovalId, tx_hash: z.string().regex(/^[0-9a-f]{64}$/), output_index: z.number().int().min(0) }),
});
/** The exact entry: a signed, unbroadcast lock tx (base64 CBOR) and the input it consumes as nonce. */
const ExactPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: z.unknown().optional(),
  accepted: z.looseObject({ scheme: z.literal('exact'), extra: z.looseObject({ escalation: z.looseObject({ approval_id: ApprovalId }) }) }),
  payload: z.strictObject({ transaction: z.string().min(1), nonce: z.string().regex(/^[0-9a-f]{64}#\d+$/) }),
});
export type ExactPayload = z.infer<typeof ExactPayloadSchema>;
export type PaymentProof =
  | { approval_id: string; tx_hash: string; output_index: number; exact?: undefined }
  | { approval_id: string; tx_hash?: undefined; output_index?: undefined; exact: { transaction_hex: string; payload: ExactPayload } };

/** The PAYMENT-SIGNATURE header, or null when absent or malformed (a malformed proof is simply "no bond"). */
export function parsePaymentSignature(header: string | string[] | undefined): PaymentProof | null {
  if (typeof header !== 'string' || header === '') return null;
  try {
    const doc: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const escrow = EscrowPayloadSchema.safeParse(doc);
    if (escrow.success) return escrow.data.payload;
    const exact = ExactPayloadSchema.parse(doc);
    const transaction_hex = Buffer.from(exact.payload.transaction, 'base64').toString('hex');
    if (transaction_hex === '') return null;
    return { approval_id: exact.accepted.extra.escalation.approval_id, exact: { transaction_hex, payload: exact } };
  } catch {
    return null;
  }
}

/**
 * Settles an exact-scheme lock through an x402 facilitator (POST /verify, then POST /settle, the request shape of
 * @x402/core HTTPFacilitatorClient). Returns the transaction hash the facilitator broadcast, also while settlement
 * is still pending (the client re-presents the same payload and the facilitator resumes), or null when the
 * facilitator rejected the payment. The escrow UTxO is still read back from Cardano afterwards.
 */
export async function settleViaFacilitator(url: string, payload: ExactPayload, requirements: ReturnType<typeof exactRequirements>): Promise<string | null> {
  const post = async (path: string) => {
    const res = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`facilitator ${path}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 500)}`);
    return body;
  };
  const verified = await post('/verify');
  if (verified.isValid !== true) {
    console.warn(`x402 facilitator rejected ${requirements.extra.escalation.approval_id}: ${String(verified.invalidReason)} ${String(verified.invalidMessage ?? '')}`);
    return null;
  }
  const settled = await post('/settle');
  const tx = typeof settled.transaction === 'string' && /^[0-9a-f]{64}$/.test(settled.transaction) ? settled.transaction : null;
  if (settled.success !== true) console.warn(`x402 facilitator settle ${requirements.extra.escalation.approval_id}: ${String(settled.errorReason)} tx ${tx ?? '-'}`);
  return settled.success === true || settled.errorReason === 'settlement_pending' ? tx : null;
}

/** The bond on record once the escrow UTxO is read back from Cardano. */
export function bondOf(price: EscalationPrice, mandateId: string, utxo: BondUtxo): Bond {
  return BondSchema.parse({
    schema: 'bond/v0.1',
    approval_id: price.approval_id,
    action_hash: price.action_hash,
    mandate_id: mandateId,
    amount: utxo.amount.toString(),
    asset: price.asset.symbol,
    escrow_address: price.escrow_address,
    tx_hash: utxo.tx_hash,
    output_index: utxo.output_index,
    locked_until_ms: price.locked_until_ms,
    status: 'locked',
    outcome_tx_hash: null,
  });
}

/** What a priced-but-unpaid (or lapsed) escalation shows as its bond: the price, nothing locked. */
export function bondRequired(price: EscalationPrice, mandateId: string, status: 'required' | 'expired'): Bond {
  return BondSchema.parse({
    schema: 'bond/v0.1',
    approval_id: price.approval_id,
    action_hash: price.action_hash,
    mandate_id: mandateId,
    amount: price.amount,
    asset: price.asset.symbol,
    escrow_address: price.escrow_address,
    tx_hash: null,
    output_index: null,
    locked_until_ms: price.locked_until_ms,
    status,
    outcome_tx_hash: null,
  });
}

export function briefFor(input: {
  action: ActionIR;
  evaluation: Evaluation;
  row: MandateRow;
  verification: { report: AnyVerificationReport; report_hash: string; sepolia_tx: string | null } | null;
  bond: { amount: string; asset: string };
  expiresAtMs: number;
}): DecisionBrief {
  return buildBrief({
    action: input.action,
    evaluation: input.evaluation,
    mandate: input.row.mandate,
    verification: input.verification,
    bond: input.bond,
    expires_at_ms: input.expiresAtMs,
  });
}

export const parseBond = (text: string | null): Bond | null => (text === null ? null : BondSchema.parse(JSON.parse(text)));
export const parsePrice = (text: string | null): EscalationPrice | null => (text === null ? null : EscalationPriceSchema.parse(JSON.parse(text)));
export const storeBond = (q: Sql, approvalId: string, bond: Bond) => q.query('update approvals set bond = $2 where id = $1', [approvalId, canonicalJson(bond)]);
