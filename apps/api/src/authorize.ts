import { type ActionIR, type AuthorizationRecord, canonicalJson, type IssueInput, issueAuthorization, type VerifiedReport } from '@authority/core';
import type { Db, Sql, StoredEvent } from '@authority/db';
import { HttpError } from './http';
import type { EventLog } from './log';
import type { MandateRow } from './mandates';
import type { CardanoPort } from './ports';
import { authorizationId, type DecisionContext } from './receipts';

/**
 * Next nonce for a vault: max(counter, on-chain last_nonce) + 1, in one atomic statement. The counter never
 * goes back. A nonce whose authorization is never executed is simply skipped: the vault only requires
 * nonce > last_nonce at release.
 */
export async function allocateNonce(q: Sql, vaultHash: string, chainLastNonce: bigint): Promise<bigint> {
  const [row] = await q.query<{ counter: string }>(
    `insert into nonces (vault_hash, counter) values ($1, $2::numeric + 1)
     on conflict (vault_hash) do update set counter = greatest(nonces.counter, $2::numeric) + 1
     returning counter::text as counter`,
    [vaultHash, chainLastNonce.toString()],
  );
  return BigInt(row!.counter);
}

/** Takes the invoice reservation. Exactly one concurrent caller gets true (primary key, real Postgres semantics). */
export async function reserveInvoice(q: Sql, mandateId: string, invoiceId: string): Promise<boolean> {
  const rows = await q.query(
    'insert into invoice_reservations (mandate_id, invoice_id) values ($1, $2) on conflict do nothing returning invoice_id',
    [mandateId, invoiceId],
  );
  return rows.length === 1;
}

/**
 * Chain reads lag block production. An authorization counts as unexecuted only when Cardano was read this long
 * after its valid_until (no release can carry a validity upper bound past valid_until, vault R7).
 */
export const RESERVATION_RELEASE_MARGIN_MS = 120_000;

export type IssueOutcome =
  | { kind: 'issued'; id: number; record: AuthorizationRecord; event: StoredEvent }
  | { kind: 'reused'; id: number; record: AuthorizationRecord }
  | { kind: 'reserved'; id: number; reason: 'settled' | 'live' | 'may have settled' };

export interface IssueRequest {
  row: MandateRow;
  /** The same inputs decide() passed to evaluate(); the gate evaluates them again itself. */
  proposal: { action: unknown; agent_signature: string | null };
  action: ActionIR;
  actionHash: string;
  state: IssueInput['state'];
  verification: VerifiedReport | null;
  approval: IssueInput['approval'];
  chainLastNonce: bigint;
  chainReadAtMs: number;
  engineKey: Uint8Array;
  runId: string;
  approvalId: number | null;
  context: DecisionContext;
  status: 'issued' | 'queued' | 'awaiting_cfo';
}

interface Holder {
  id: string;
  run_id: string;
  action_id: string;
  action_hash: string;
  record: string;
  status: string;
  valid_until: string;
  nonce: string;
  tx_hash: string | null;
}

/**
 * Issues at most one authorization per invoice, ever able to pay it. The reservation (invoice_reservations primary
 * key) is taken in the signing transaction. The same action again gets the live record back (no new nonce). Any
 * other issuance is refused while the holder is settled, live, or possibly settled. The reservation is released,
 * and the release logged, only when the holder expired before Cardano was read and no transaction executed it.
 * IssuanceRefused from the gate propagates and rolls everything back, reservation included.
 */
export async function issueOnce(deps: { db: Db; log: EventLog; now: () => number; cardano: CardanoPort }, r: IssueRequest): Promise<IssueOutcome> {
  const mandateId = r.row.mandate.id;
  const invoiceId = r.action.reference?.invoice_id;
  if (invoiceId === undefined) throw new Error('issueOnce: an authorizable action always references an invoice');
  const { out, events } = await deps.db.tx(async (q) => {
    const events: StoredEvent[] = [];
    let won = await reserveInvoice(q, mandateId, invoiceId);
    if (!won) {
      const [held] = await q.query<Holder>(
        `select a.id::text as id, a.run_id::text as run_id, a.action_id, a.action_hash, a.record, a.status,
           a.valid_until::text as valid_until, a.nonce::text as nonce, a.tx_hash
         from invoice_reservations v join authorizations a on a.id = v.authorization_id
         where v.mandate_id = $1 and v.invoice_id = $2 for update of v`,
        [mandateId, invoiceId],
      );
      if (!held) throw new HttpError(429, 'the invoice reservation is changing, retry', { 'retry-after': '1' });
      const id = Number(held.id);
      const record = JSON.parse(held.record) as AuthorizationRecord;
      const validUntil = Number(held.valid_until);
      if (held.status === 'settled') return { out: { kind: 'reserved', id, reason: 'settled' } as const, events };
      if (validUntil > deps.now()) {
        if (held.action_hash === r.actionHash) return { out: { kind: 'reused', id, record } as const, events };
        return { out: { kind: 'reserved', id, reason: 'live' } as const, events };
      }
      if (validUntil + RESERVATION_RELEASE_MARGIN_MS >= r.chainReadAtMs) {
        throw new HttpError(429, `authorization ${authorizationId(id)} just expired; retry once the chain has caught up`, { 'retry-after': '120' });
      }
      // One Cardano read under the row lock; fine at one release per vault per block.
      const settledBy = BigInt(held.nonce) > r.chainLastNonce ? null : await deps.cardano.releaseOf(r.row.binding, record);
      if (settledBy !== null) {
        await q.query(`update authorizations set status = 'settled', tx_hash = $2 where id = $1`, [id, settledBy]);
        return { out: { kind: 'reserved', id, reason: 'may have settled' } as const, events };
      }
      await q.query('delete from invoice_reservations where mandate_id = $1 and invoice_id = $2', [mandateId, invoiceId]);
      await q.query(`update authorizations set status = 'expired' where id = $1`, [id]);
      events.push(
        await deps.log.append(q, {
          run_id: held.run_id,
          action_id: held.action_id,
          type: 'TransactionRejected',
          payload: {
            tx_hash: held.tx_hash,
            invariant: 'EXPIRED',
            error: `authorization ${authorizationId(id)} expired unexecuted; reservation for invoice ${invoiceId} released`,
            tx_body_cbor: null,
            reservation_released: invoiceId,
          },
        }),
      );
      won = await reserveInvoice(q, mandateId, invoiceId);
      if (!won) throw new HttpError(429, 'the invoice reservation is changing, retry', { 'retry-after': '1' });
    }
    const nowMs = deps.now();
    const nonce = await allocateNonce(q, r.row.binding.vaultHash, r.chainLastNonce);
    const record = issueAuthorization({
      mandate: r.row.mandate,
      proposal: r.proposal,
      state: r.state,
      verification: r.verification,
      nowMs,
      approval: r.approval,
      chain: r.row.binding,
      nonce,
      engineSecretKey: r.engineKey,
    });
    const [row] = await q.query<{ id: string }>(
      `insert into authorizations
         (run_id, mandate_id, invoice_id, action_id, action_hash, digest, nonce, valid_until, record, context, approval_id, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id::text as id`,
      [
        r.runId,
        mandateId,
        invoiceId,
        r.action.id,
        record.fields.action_hash,
        record.digest_hex,
        nonce.toString(),
        record.fields.valid_until,
        canonicalJson(record),
        canonicalJson(r.context),
        r.approvalId,
        r.status,
      ],
    );
    await q.query('update invoice_reservations set authorization_id = $3 where mandate_id = $1 and invoice_id = $2', [
      mandateId,
      invoiceId,
      row!.id,
    ]);
    const event = await deps.log.append(q, {
      run_id: r.runId,
      action_id: r.action.id,
      type: 'AuthorizationIssued',
      payload: { authorization: record, compromised_engine: false },
    });
    events.push(event);
    return { out: { kind: 'issued', id: Number(row!.id), record, event } as const, events };
  });
  for (const e of events) deps.log.publish(e);
  return out;
}
