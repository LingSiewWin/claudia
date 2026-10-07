import { ActionIRSchema, type Bond, canonicalHash, canonicalJson, DAY_MS, IssuanceRefused, utf8ToBytes } from '@authority/core';
import * as z from 'zod';
import { issueOnce } from './authorize';
import { decide, decisionContext, type Emit, type Engine, type Proposal } from './check';
import { paymentKeyHash, verifyCip8 } from './cose';
import { BOND_ASSET, bondRequired, escalationsToday, parseBond, parsePrice, storeBond, withBudget } from './escalation';
import { buildRelease } from './executor';
import { HttpError, parseJson, type Reply } from './http';
import { currentMandate, readChain } from './mandates';
import { authorizationId } from './receipts';
import { type BondOutcome, CardanoError } from './ports';

export type DeclineReason = 'legitimate' | 'frivolous';

/** The exact text the CFO signs (CIP-30 signData, CIP-8) to decline; same function as the web app's declineMessage. */
export const declineMessage = (approvalId: string, reason: DeclineReason) => canonicalJson({ approval_id: approvalId, decision: 'decline', reason });

type Status = 'awaiting_bond' | 'pending' | 'approving' | 'authorized' | 'declined' | 'closed' | 'expired';
interface ApprovalRow {
  id: string;
  run_id: string;
  mandate_id: string;
  action_id: string;
  proposal: string;
  evaluation: string;
  status: Status;
  price: string | null;
  brief: string | null;
  brief_hash: string | null;
  bond: string | null;
  bond_tx: string | null;
  decline_reason: DeclineReason | null;
  requested_at: string;
}
const COLUMNS = `id::text as id, run_id::text as run_id, mandate_id, action_id, proposal, evaluation, status, price, brief, brief_hash, bond, bond_tx, decline_reason,
  to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as requested_at`;

async function load(eng: Engine, approvalId: string): Promise<ApprovalRow> {
  const n = /^AP-(\d{1,18})$/.exec(approvalId)?.[1];
  const [row] = n ? await eng.db.query<ApprovalRow>(`select ${COLUMNS} from approvals where id = $1`, [n]) : [];
  if (!row) throw new HttpError(404, 'unknown approval');
  return row;
}

/** The bond as the console shows it: on record once locked, otherwise the price with nothing locked. */
function bondView(r: ApprovalRow): Bond | null {
  const bond = parseBond(r.bond);
  if (bond) return bond;
  const price = parsePrice(r.price);
  return price && bondRequired(price, r.mandate_id, r.status === 'expired' ? 'expired' : 'required');
}

const view = (r: ApprovalRow) => ({
  approval_id: `AP-${r.id}`,
  run_id: r.run_id,
  status: r.status,
  action: (JSON.parse(r.proposal) as Proposal).action,
  // Display only. Approve re-evaluates from scratch; this stored copy never reaches the issuance gate.
  evaluation: JSON.parse(r.evaluation),
  brief: r.brief === null ? null : JSON.parse(r.brief),
  brief_hash: r.brief_hash,
  bond: bondView(r),
  requested_at: r.requested_at,
});

export async function pendingApprovals(eng: Engine) {
  await expireApprovals(eng);
  const rows = await eng.db.query<ApprovalRow>(`select ${COLUMNS} from approvals where status = 'pending' order by approvals.id`);
  return rows.map(view);
}

export async function approvalView(eng: Engine, approvalId: string): Promise<Reply> {
  await expireApprovals(eng);
  return { status: 200, body: view(await load(eng, approvalId)) };
}

const emitter = (eng: Engine, ap: ApprovalRow): Emit => (type, payload) => eng.log.emit({ run_id: ap.run_id, action_id: ap.action_id, type, payload });
const bondTxOf = (r: ApprovalRow) => (r.bond_tx === null ? null : (JSON.parse(r.bond_tx) as { txCbor: string; txHash: string }));
const bondTxView = (r: ApprovalRow) => {
  const tx = bondTxOf(r);
  return tx && { unsigned_tx_cbor: tx.txCbor, tx_hash: tx.txHash };
};

/** Builds the unsigned bond spend for the approver wallet and stores it; null when no bond is locked. */
async function prepareBondSpend(eng: Engine, ap: ApprovalRow, outcome: BondOutcome): Promise<{ unsigned_tx_cbor: string; tx_hash: string } | null> {
  const bond = parseBond(ap.bond);
  const price = parsePrice(ap.price);
  if (!bond || !price || bond.status !== 'locked') return null;
  const utxo = await eng.cardano.readBond(price);
  if (!utxo) return null;
  const tx = await eng.cardano.buildBondSpend(utxo, outcome);
  await eng.db.query('update approvals set bond_tx = $2 where id = $1', [ap.id, canonicalJson({ txCbor: tx.txCbor, txHash: tx.txHash })]);
  return { unsigned_tx_cbor: tx.txCbor, tx_hash: tx.txHash };
}

/**
 * "Approve once": fresh Cardano state, fresh CRE verification, fresh evaluation. Signs with requires_principal = 1
 * only if the outcome is still ESCALATE, then builds the release the CFO wallet must co-sign. The bond refund is a
 * second unsigned tx for the same wallet (the release builder takes no extra inputs); see bondSubmit.
 */
export async function approve(eng: Engine, approvalId: string): Promise<Reply> {
  await expireApprovals(eng);
  const ap = await load(eng, approvalId);
  if (ap.status === 'authorized') {
    const [a] = await eng.db.query<{ record: string; unsigned_tx: string; tx_hash: string }>(
      `select record, unsigned_tx, tx_hash from authorizations
       where approval_id = $1 and status = 'awaiting_cfo' and unsigned_tx is not null and valid_until > $2
       order by authorizations.id desc limit 1`,
      [ap.id, eng.now() + 60_000],
    );
    if (a) {
      return {
        status: 200,
        body: { approval_id: approvalId, authorization: JSON.parse(a.record), unsigned_tx_cbor: a.unsigned_tx, tx_hash: a.tx_hash, bond_tx: bondTxView(ap) },
      };
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
    // This escalation already holds its budget unit; the gate must not count it twice.
    chain.state = await withBudget(eng.db, row.mandate.id, chain.state, eng.now(), Number(ap.id));
    const emit = emitter(eng, ap);
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
    const bond = parseBond(ap.bond);
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
      context: decisionContext(
        row,
        action,
        proposal,
        d,
        { required: true, cfo_key_hash: cfo, brief_hash: ap.brief_hash, bond: bond && { status: bond.status, tx_hash: bond.tx_hash, outcome_tx_hash: bond.outcome_tx_hash } },
        proposed?.hash ?? '',
      ),
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
    const bondTx = bondTxView(ap) ?? (await prepareBondSpend(eng, ap, 'refund'));
    settledState = 'authorized';
    return { status: 200, body: { approval_id: approvalId, authorization: out.record, unsigned_tx_cbor: tx.txCbor, tx_hash: tx.txHash, bond_tx: bondTx } };
  } finally {
    await eng.db.query('update approvals set status = $2 where id = $1', [ap.id, settledState ?? 'pending']);
  }
}

const DeclineSchema = z.strictObject({
  signature: z.string().regex(/^[0-9a-f]{2,8192}$/),
  key: z.string().regex(/^[0-9a-f]{2,1024}$/),
  reason: z.enum(['legitimate', 'frivolous']),
});

/**
 * Decline needs the payment approver: a CIP-8 COSE_Sign1 whose payload is declineMessage(approval_id, reason) byte
 * for byte, signed by a key that hashes to the anchor's approver key hash, with the protected address header paying
 * to that same key hash. The key hash comes from the chain, not from our database. The reason decides the bond:
 * legitimate refunds the agent, frivolous captures it to the sink. The approver receives nothing either way.
 */
export async function decline(eng: Engine, approvalId: string, rawBody: string): Promise<Reply> {
  const body = DeclineSchema.safeParse(parseJson(rawBody === '' ? '{}' : rawBody));
  if (!body.success) throw new HttpError(401, 'decline needs the CFO signature and a reason: { signature, key, reason: legitimate | frivolous }');
  await expireApprovals(eng);
  const ap = await load(eng, approvalId);
  const row = await currentMandate(eng.db, ap.mandate_id);
  if (!row) throw new HttpError(500, `mandate ${ap.mandate_id} is not configured`);
  let approver: string;
  try {
    approver = (await eng.cardano.readAnchor(row.binding)).approver_pkh;
  } catch (error) {
    throw new HttpError(503, `cardano state unavailable: ${(error as Error).message}`, { 'retry-after': '10' });
  }
  const { reason } = body.data;
  const signer = verifyCip8(body.data.signature, body.data.key, utf8ToBytes(declineMessage(approvalId, reason)));
  if (!signer || signer.keyHash !== approver || paymentKeyHash(signer.address, row.binding.chainTag) !== approver) {
    throw new HttpError(401, "decline must be signed by the mandate's CFO key over this approval and reason");
  }
  const updated = await eng.db.query(
    `update approvals set status = 'declined', decline_reason = $2 where id = $1 and status in ('pending', 'authorized') returning id`,
    [ap.id, reason],
  );
  if (updated.length === 0) throw new HttpError(409, `approval is ${ap.status}`);
  await eng.db.query(
    `update authorizations set status = 'failed', error = 'declined by the CFO' where approval_id = $1 and status = 'awaiting_cfo'`,
    [ap.id],
  );
  await emitter(eng, ap)('CFODeclined', { approval_id: approvalId, reason });
  const bondTx = await prepareBondSpend(eng, ap, reason === 'frivolous' ? 'capture' : 'refund');
  return { status: 200, body: { ok: true, reason, bond_tx: bondTx } };
}

const BondSubmitSchema = z.strictObject({
  tx_hash: z.string().regex(/^[0-9a-f]{64}$/),
  cfo_witness_cbor: z.string().regex(/^[0-9a-f]{2,8192}$/),
});

/**
 * The approver's CIP-30 witness for the bond spend built at approve or decline time. Submits, waits for the block,
 * records the outcome. Refund after approval or a legitimate decline; Capture to the sink after a frivolous one.
 */
export async function bondSubmit(eng: Engine, approvalId: string, rawBody: string): Promise<Reply> {
  const body = BondSubmitSchema.safeParse(parseJson(rawBody));
  if (!body.success) throw new HttpError(400, 'body must be { tx_hash, cfo_witness_cbor }');
  const ap = await load(eng, approvalId);
  const bond = parseBond(ap.bond);
  const tx = bondTxOf(ap);
  if (!bond || !tx) throw new HttpError(409, 'no bond spend is waiting for the CFO signature');
  if (bond.status !== 'locked') throw new HttpError(409, `bond is ${bond.status}`);
  if (tx.txHash !== body.data.tx_hash) throw new HttpError(409, 'tx_hash is not the bond spend built for this approval');
  const outcome: BondOutcome = ap.status === 'declined' && ap.decline_reason === 'frivolous' ? 'capture' : 'refund';
  let txHash: string;
  try {
    txHash = await eng.cardano.submit({ txCbor: tx.txCbor, witnessSets: [body.data.cfo_witness_cbor] });
  } catch (error) {
    const err = error instanceof CardanoError ? error : new CardanoError('SUBMIT_FAILED', (error as Error).message);
    throw new HttpError(409, `the bond spend was rejected: ${err.invariant ?? err.code} ${err.message}`);
  }
  const confirmed = await eng.cardano.awaitConfirmation(txHash, eng.now() + 600_000);
  if (!confirmed) throw new HttpError(409, 'the bond spend did not confirm');
  const settled: Bond = { ...bond, status: outcome === 'capture' ? 'captured' : 'refunded', outcome_tx_hash: txHash };
  await storeBond(eng.db, ap.id, settled);
  const emit = emitter(eng, ap);
  if (outcome === 'capture') await emit('BondCaptured', { approval_id: approvalId, tx_hash: txHash, sink_address: eng.cardano.bondAddresses().sink });
  else await emit('BondRefunded', { approval_id: approvalId, tx_hash: txHash, reason: ap.status === 'declined' ? 'declined_legitimate' : 'approved' });
  return { status: 200, body: { ok: true, tx_hash: txHash, bond: settled } };
}

/**
 * Escalations whose hour ran out: the approval expires, and a locked bond goes back to the agent through the
 * validator's time-based Refund, which needs no approver signature (anyone can refund; the fee wallet does).
 */
export async function expireApprovals(eng: Engine): Promise<void> {
  const rows = await eng.db.query<ApprovalRow>(
    `select ${COLUMNS} from approvals where status in ('awaiting_bond', 'pending', 'authorized') and locked_until_ms is not null and locked_until_ms <= $1`,
    [eng.now()],
  );
  for (const ap of rows) {
    const claimed = await eng.db.query(`update approvals set status = 'expired' where id = $1 and status = $2 returning id`, [ap.id, ap.status]);
    if (claimed.length === 0) continue;
    await eng.db.query(`update authorizations set status = 'failed', error = 'approval expired' where approval_id = $1 and status = 'awaiting_cfo'`, [ap.id]);
    const bond = parseBond(ap.bond);
    const price = parsePrice(ap.price);
    if (!bond || !price || bond.status !== 'locked') continue;
    try {
      const utxo = await eng.cardano.readBond(price);
      if (!utxo) continue; // already refunded by the agent itself
      const tx = await eng.cardano.buildBondSpend(utxo, 'refund');
      const txHash = await eng.cardano.submit({ txCbor: tx.txCbor, witnessSets: [] });
      if (!(await eng.cardano.awaitConfirmation(txHash, eng.now() + 600_000))) continue;
      await storeBond(eng.db, ap.id, { ...bond, status: 'refunded', outcome_tx_hash: txHash });
      await emitter(eng, ap)('BondRefunded', { approval_id: `AP-${ap.id}`, tx_hash: txHash, reason: 'expired' });
    } catch (error) {
      console.error(`bond refund for AP-${ap.id} failed: ${(error as Error).message}`);
    }
  }
}

/** Public: what interrupting this approver costs right now and whether the day's budget has room. */
export async function authorityView(eng: Engine, role: string, mandateId: string): Promise<Reply> {
  const row = await currentMandate(eng.db, mandateId);
  if (!row) throw new HttpError(404, `unknown mandate ${mandateId}`);
  const approver = row.mandate.approvers.find((a) => a.role === role);
  if (!approver) throw new HttpError(404, `no approver with role ${role} under ${mandateId}`);
  const perDay = row.mandate.interrupt_budget.per_day;
  const used = await escalationsToday(eng.db, row.mandate.id, Math.floor(eng.now() / DAY_MS));
  return {
    status: 200,
    body: {
      approver: { role: approver.role, key_hash: approver.cardano_key_hash },
      mandate_id: row.mandate.id,
      price: { amount: eng.bondLovelace, asset: BOND_ASSET },
      interrupt_budget: { used, per_day: perDay },
      escalations_today: used,
      availability: used >= perDay ? 'budget_exhausted' : 'open',
    },
  };
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
