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
  type VerificationReport,
} from '@authority/core';
import type { Sql } from '@authority/db';
import * as z from 'zod';
import type { Engine } from './check';
import type { Reply } from './http';
import type { MandateRow } from './mandates';
import type { BondUtxo } from './ports';

/*
 * x402 escalation: an ESCALATE that wants execution is priced before any human sees it. The price is a bond the
 * agent locks in the escrow validator; the interrupt budget counts only escalations whose bond was locked.
 * Transport per coinbase/x402 transports-v2/http: PAYMENT-REQUIRED (402 reply), PAYMENT-SIGNATURE (retry),
 * PAYMENT-RESPONSE (settled 200), each a base64 JSON document.
 */

export const BOND_LOCK_MS = 3_600_000;
export const DEFAULT_BOND_LOVELACE = '5000000';
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
  eng: Pick<Engine, 'bondLovelace' | 'cardano' | 'now'>,
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

export function paymentRequired(publicApiUrl: string, price: EscalationPrice, actionId: string) {
  const asset = price.asset.policy_id === '' ? 'lovelace' : `${price.asset.policy_id}.${price.asset.asset_name}`;
  return {
    x402Version: 2,
    error: 'escalation requires a bond',
    resource: { url: `${publicApiUrl}/v1/authority/check`, description: `Human authority for action ${actionId}` },
    accepts: [
      {
        scheme: 'cardano-escrow',
        network: price.network,
        amount: price.amount,
        asset,
        payTo: price.escrow_address,
        maxTimeoutSeconds: BOND_LOCK_MS / 1000,
        extra: price,
      },
    ],
  };
}

/** 402: header and body carry the same PaymentRequired document. */
export function reply402(publicApiUrl: string, price: EscalationPrice, actionId: string): Reply {
  const body = paymentRequired(publicApiUrl, price, actionId);
  return { status: 402, body, headers: { 'payment-required': b64(body) } };
}

export const paymentResponse = (network: EscalationPrice['network'], txHash: string) => b64({ success: true, network, transaction: txHash });

const PaymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  accepted: z.unknown(),
  payload: z.strictObject({ approval_id: z.string().min(1).max(64), tx_hash: z.string().regex(/^[0-9a-f]{64}$/), output_index: z.number().int().min(0) }),
});
export type PaymentProof = z.infer<typeof PaymentPayloadSchema>['payload'];

/** The PAYMENT-SIGNATURE header, or null when absent or malformed (a malformed proof is simply "no bond"). */
export function parsePaymentSignature(header: string | string[] | undefined): PaymentProof | null {
  if (typeof header !== 'string' || header === '') return null;
  try {
    return PaymentPayloadSchema.parse(JSON.parse(Buffer.from(header, 'base64').toString('utf8'))).payload;
  } catch {
    return null;
  }
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
  verification: { report: VerificationReport; report_hash: string; sepolia_tx: string } | null;
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
