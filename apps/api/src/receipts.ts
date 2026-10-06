import { type ActionIR, type AuthorizationRecord, canonicalHash, canonicalJson, type Check, type Mandate, parseMandate } from '@authority/core';
import type { Db, Sql } from '@authority/db';
import { HttpError } from './http';
import type { MandateRow } from './mandates';

/** What a receipt needs to know about the decision; stored with each authorization for the settlement receipt. */
export interface DecisionContext {
  mandate_version: number;
  action: ActionIR | null;
  action_hash: string | null;
  agent_signature: string | null;
  evaluation: { outcome: string; reason: string | null; checks: Check[] };
  verification: { report_hash: string; sepolia_tx: string; result: string } | null;
  approval: { required: boolean; cfo_key_hash: string | null };
  first_event_hash: string;
}

export const receiptId = (n: number | string) => `R-${String(n).padStart(4, '0')}`;
export const authorizationId = (n: number | string) => `Z-${String(n).padStart(4, '0')}`;
const verificationId = (reportHash: string) => `V-${reportHash.slice(0, 12)}`;

// Receipt document. A decision receipt (no settlement) carries null for what did not happen.
export function receiptBody(
  row: MandateRow,
  ctx: DecisionContext,
  extra: {
    authorization: { id: number; record: AuthorizationRecord } | null;
    settlement: { chain: 'cardano-preprod'; tx_hash: string; block: number } | null;
    last_event_hash: string;
  },
) {
  const vid = ctx.verification ? verificationId(ctx.verification.report_hash) : null;
  const auth = extra.authorization;
  return {
    schema: 'receipt/v0.1',
    principal: row.mandate.principal.name,
    delegate: row.delegateName,
    mandate: { id: row.mandate.id, version: row.mandate.version, hash: row.hash, anchor: row.binding.mandateRef },
    action: { ir: ctx.action, hash: ctx.action_hash, agent_signature: ctx.agent_signature },
    evaluation: ctx.evaluation,
    verification: ctx.verification && vid ? { id: vid, ...ctx.verification } : null,
    authorization: auth && {
      id: authorizationId(auth.id),
      verification_id: vid,
      digest: auth.record.digest_hex,
      signature: auth.record.signature_hex,
      engine_public_key: auth.record.engine_public_key,
      nonce: auth.record.fields.nonce,
      valid_until: auth.record.fields.valid_until,
    },
    approval: ctx.approval,
    settlement: extra.settlement,
    masumi: null,
    evidence: { first_event_hash: ctx.first_event_hash, last_event_hash: extra.last_event_hash },
  };
}

export async function storeReceipt(
  q: Sql,
  input: { kind: 'decision' | 'settlement'; mandateId: string; actionId: string | null; authorizationId: number | null; body: unknown },
): Promise<{ id: string; hash: string }> {
  const hash = canonicalHash(input.body);
  const [row] = await q.query<{ id: string }>(
    `insert into receipts (kind, mandate_id, action_id, authorization_id, body, hash) values ($1, $2, $3, $4, $5, $6) returning id::text as id`,
    [input.kind, input.mandateId, input.actionId, input.authorizationId, canonicalJson(input.body), hash],
  );
  return { id: receiptId(row!.id), hash };
}

export async function mandateAt(q: Sql, id: string, version: number): Promise<Mandate> {
  const [row] = await q.query<{ doc: string }>('select doc from mandates where id = $1 and version = $2', [id, version]);
  if (!row) throw new Error(`mandate ${id}@${version} is not stored`);
  return parseMandate(JSON.parse(row.doc));
}

export async function receiptBundle(db: Db, id: string) {
  const n = /^R-(\d{1,18})$/.exec(id)?.[1];
  const [row] = n ? await db.query<{ body: string; hash: string; record: string | null }>(
    `select r.body, r.hash, a.record from receipts r left join authorizations a on a.id = r.authorization_id where r.id = $1`,
    [n],
  ) : [];
  if (!row) throw new HttpError(404, 'unknown receipt');
  const receipt = JSON.parse(row.body) as { mandate: { id: string; version: number } };
  return {
    receipt,
    receipt_hash: row.hash,
    authorization: row.record === null ? null : (JSON.parse(row.record) as AuthorizationRecord),
    mandate: await mandateAt(db, receipt.mandate.id, receipt.mandate.version),
  };
}

export async function settlementReceipts(db: Db, mandateId: string) {
  const rows = await db.query<{ id: string; body: string; created_at: string }>(
    `select id::text as id, body, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
     from receipts where kind = 'settlement' and mandate_id = $1 order by receipts.id desc limit 100`,
    [mandateId],
  );
  return rows.map((r) => {
    const body = JSON.parse(r.body) as { action: { ir: ActionIR }; settlement: { tx_hash: string } };
    return {
      receipt_id: receiptId(r.id),
      action_id: body.action.ir.id,
      counterparty: body.action.ir.counterparty.display,
      amount: body.action.ir.amount.value,
      settled_tx: body.settlement.tx_hash,
      created_at: r.created_at,
    };
  });
}
