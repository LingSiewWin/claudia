import { ActionIRSchema, canonicalHash, canonicalJson, IssuanceRefused, utf8ToBytes } from '@authority/core';
import * as z from 'zod';
import { issueOnce } from './authorize';
import { decide, decisionContext, type Emit, type Engine, type Proposal } from './check';
import { authorizationId } from './receipts';
import { paymentKeyHash, verifyCip8 } from './cose';
import { buildRelease } from './executor';
import { HttpError, parseJson, type Reply } from './http';
import { currentMandate, readChain } from './mandates';
import { CardanoError } from './ports';

/** The exact text the CFO signs (CIP-30 signData, CIP-8) to decline; same function as the web app's declineMessage. */
export const declineMessage = (approvalId: string) => canonicalJson({ approval_id: approvalId, decision: 'decline' });

interface ApprovalRow {
  id: string;
  run_id: string;
  mandate_id: string;
  action_id: string;
  proposal: string;
  evaluation: string;
  status: 'pending' | 'approving' | 'authorized' | 'declined' | 'closed';
  requested_at: string;
}
const COLUMNS = `id::text as id, run_id::text as run_id, mandate_id, action_id, proposal, evaluation, status,
  to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as requested_at`;

async function load(eng: Engine, approvalId: string): Promise<ApprovalRow> {
  const n = /^AP-(\d{1,18})$/.exec(approvalId)?.[1];
  const [row] = n ? await eng.db.query<ApprovalRow>(`select ${COLUMNS} from approvals where id = $1`, [n]) : [];
  if (!row) throw new HttpError(404, 'unknown approval');
  return row;
}

export async function pendingApprovals(eng: Engine) {
  const rows = await eng.db.query<ApprovalRow>(`select ${COLUMNS} from approvals where status = 'pending' order by approvals.id`);
  return rows.map((r) => ({
    approval_id: `AP-${r.id}`,
    run_id: r.run_id,
    action: (JSON.parse(r.proposal) as Proposal).action,
    // Display only. Approve re-evaluates from scratch; this stored copy never reaches the issuance gate.
    evaluation: JSON.parse(r.evaluation),
    requested_at: r.requested_at,
  }));
}

/**
 * "Approve once": fresh Cardano state, fresh CRE verification, fresh evaluation. Signs with requires_principal = 1
 * only if the outcome is still ESCALATE, then builds the release the CFO wallet must co-sign.
 */
export async function approve(eng: Engine, approvalId: string): Promise<Reply> {
  const ap = await load(eng, approvalId);
  if (ap.status === 'authorized') {
    const [a] = await eng.db.query<{ record: string; unsigned_tx: string; tx_hash: string }>(
      `select record, unsigned_tx, tx_hash from authorizations
       where approval_id = $1 and status = 'awaiting_cfo' and unsigned_tx is not null and valid_until > $2
       order by authorizations.id desc limit 1`,
      [ap.id, eng.now() + 60_000],
    );
    if (a) {
      return { status: 200, body: { approval_id: approvalId, authorization: JSON.parse(a.record), unsigned_tx_cbor: a.unsigned_tx, tx_hash: a.tx_hash } };
    }
  }
  const claimed = await eng.db.query(
    `update approvals set status = 'approving' where id = $1 and status in ('pending', 'authorized') returning id`,
    [ap.id],
  );
  if (claimed.length === 0) {
    if (ap.status === 'approving') throw new HttpError(429, 'this approval is being processed', { 'retry-after': '10' });
    throw new HttpError(409, `approval is ${ap.status}`);
  }
  let settledState: 'authorized' | 'closed' | null = null;
  try {
    const row = await currentMandate(eng.db, ap.mandate_id);
    const engineKey = row && eng.engineKeys.get(row.mandate.id);
    if (!row || !engineKey) throw new HttpError(500, `mandate ${ap.mandate_id} is not configured`);
    const proposal = JSON.parse(ap.proposal) as Proposal;
    const parsed = ActionIRSchema.safeParse(proposal.action);
    const action = parsed.success ? parsed.data : null;
    const chain = await readChain(eng.cardano, row, eng.now());
    const emit: Emit = (type, payload) => eng.log.emit({ run_id: ap.run_id, action_id: ap.action_id, type, payload });
    // The payment approver key hash comes from the anchor datum on Cardano, not from our copy of the mandate.
    const cfo = chain.anchor.approver_pkh;
    await emit('CFOApproved', { approval_id: approvalId, cfo_key_hash: cfo });
    const d = await decide(eng, { row, proposal, state: chain.state, action, emit });
    const e = d.evaluation;
    if (e.outcome !== 'ESCALATE' || !e.signed || !action) {
      if (e.outcome === 'DENY' && e.reason) await emit('ActionDenied', { reason: e.reason, layer: d.deniedBy });
      settledState = 'closed';
      throw new HttpError(409, `re-evaluation returned ${e.outcome}${e.reason ? ` ${e.reason}` : ''}; the agent must propose again`);
    }
    const [proposed] = await eng.db.query<{ hash: string }>(
      `select encode(hash, 'hex') as hash from events where run_id = $1 and action_id = $2 and type = 'ActionProposed' order by seq limit 1`,
      [ap.run_id, ap.action_id],
    );
    const approver = e.approvals_required[0]?.approver;
    if (approver === undefined) throw new Error('ESCALATE without an approver');
    const actionHash = canonicalHash(action);
    const issue = issueOnce(eng, {
      row,
      proposal,
      action,
      actionHash,
      state: chain.state,
      verification: d.verified,
      approval: { approver, approved_at_ms: eng.now(), action_hash: actionHash },
      chainLastNonce: BigInt(chain.state.last_nonce),
      chainReadAtMs: chain.readAtMs,
      engineKey,
      runId: ap.run_id,
      approvalId: Number(ap.id),
      context: decisionContext(row, action, proposal, d, { required: true, cfo_key_hash: cfo }, proposed?.hash ?? ''),
      status: 'awaiting_cfo',
    });
    const out = await issue.catch((error: unknown) => {
      if (!(error instanceof IssuanceRefused)) throw error;
      settledState = 'closed';
      throw new HttpError(422, error.message);
    });
    if (out.kind === 'reserved') {
      await emit('ActionDenied', { reason: 'INVOICE_NOT_OPEN', layer: 'engine' });
      settledState = 'closed';
      throw new HttpError(409, `invoice already reserved by authorization ${authorizationId(out.id)} (${out.reason}): INVOICE_NOT_OPEN`);
    }
    let tx;
    try {
      tx = await buildRelease(eng, row, out.record, cfo, { runId: ap.run_id, actionId: ap.action_id });
    } catch (error) {
      const err = error instanceof CardanoError ? error : new CardanoError('SUBMIT_FAILED', (error as Error).message);
      await eng.db.query(`update authorizations set status = 'failed', error = $2 where id = $1`, [out.id, err.message]);
      await emit('TransactionRejected', { tx_hash: null, invariant: err.invariant ?? err.code, error: err.message, tx_body_cbor: err.txCbor });
      settledState = 'closed';
      throw new HttpError(409, `the release cannot be built: ${err.invariant ?? err.code} ${err.message}`);
    }
    await eng.db.query('update authorizations set unsigned_tx = $2, tx_hash = $3 where id = $1', [out.id, tx.txCbor, tx.txHash]);
    settledState = 'authorized';
    return { status: 200, body: { approval_id: approvalId, authorization: out.record, unsigned_tx_cbor: tx.txCbor, tx_hash: tx.txHash } };
  } finally {
    await eng.db.query('update approvals set status = $2 where id = $1', [ap.id, settledState ?? 'pending']);
  }
}

const DeclineSchema = z.strictObject({
  signature: z.string().regex(/^[0-9a-f]{2,8192}$/),
  key: z.string().regex(/^[0-9a-f]{2,1024}$/),
});

/**
 * Decline needs the payment approver: a CIP-8 COSE_Sign1 whose payload is declineMessage(approval_id) byte for byte,
 * signed by a key that hashes to the anchor's approver key hash, with the protected address header paying to
 * that same key hash. The key hash comes from the chain, not from our database.
 */
export async function decline(eng: Engine, approvalId: string, rawBody: string): Promise<Reply> {
  const body = DeclineSchema.safeParse(parseJson(rawBody === '' ? '{}' : rawBody));
  if (!body.success) throw new HttpError(401, 'decline needs the CFO signature: { signature, key } from CIP-30 signData');
  const ap = await load(eng, approvalId);
  const row = await currentMandate(eng.db, ap.mandate_id);
  if (!row) throw new HttpError(500, `mandate ${ap.mandate_id} is not configured`);
  let approver: string;
  try {
    approver = (await eng.cardano.readAnchor(row.binding)).approver_pkh;
  } catch (error) {
    throw new HttpError(503, `cardano state unavailable: ${(error as Error).message}`, { 'retry-after': '10' });
  }
  const signer = verifyCip8(body.data.signature, body.data.key, utf8ToBytes(declineMessage(approvalId)));
  if (!signer || signer.keyHash !== approver || paymentKeyHash(signer.address, row.binding.chainTag) !== approver) {
    throw new HttpError(401, "decline must be signed by the mandate's CFO key over this approval");
  }
  const updated = await eng.db.query(
    `update approvals set status = 'declined' where id = $1 and status in ('pending', 'authorized') returning id`,
    [ap.id],
  );
  if (updated.length === 0) throw new HttpError(409, `approval is ${ap.status}`);
  await eng.db.query(
    `update authorizations set status = 'failed', error = 'declined by the CFO' where approval_id = $1 and status = 'awaiting_cfo'`,
    [ap.id],
  );
  await eng.log.emit({ run_id: ap.run_id, action_id: ap.action_id, type: 'CFODeclined', payload: { approval_id: approvalId } });
  return { status: 200, body: { ok: true } };
}

const ExecuteSchema = z.strictObject({
  approval_id: z.string().regex(/^AP-\d{1,18}$/),
  authorization_digest: z.string().regex(/^[0-9a-f]{64}$/),
  cfo_witness_cbor: z.string().regex(/^[0-9a-f]{2,8192}$/),
});

/** The CFO's CIP-30 partial signature for the release built at approval time. The executor merges it and submits. */
export async function submitApproved(eng: Engine, rawBody: string): Promise<Reply> {
  const body = ExecuteSchema.safeParse(parseJson(rawBody));
  if (!body.success) throw new HttpError(400, 'body must be { approval_id, authorization_digest, cfo_witness_cbor }');
  const ap = await load(eng, body.data.approval_id);
  const [a] = await eng.db.query<{ id: string; tx_hash: string; run_id: string }>(
    `update authorizations set status = 'queued', cfo_witness = $3
     where approval_id = $1 and digest = $2 and status = 'awaiting_cfo' and unsigned_tx is not null
     returning id::text as id, tx_hash, run_id::text as run_id`,
    [ap.id, body.data.authorization_digest, body.data.cfo_witness_cbor],
  );
  if (!a) throw new HttpError(409, 'no authorization of this approval is waiting for the CFO signature');
  eng.enqueue(Number(a.id));
  return { status: 200, body: { run_id: a.run_id, tx_hash: a.tx_hash } };
}
