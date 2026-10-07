import { randomUUID } from 'node:crypto';
import {
  type ActionIR,
  ActionIRSchema,
  type AuthorizationRecord,
  type Bond,
  briefHash,
  canonicalHash,
  canonicalJson,
  type DecisionBrief,
  type DecisionOutcome,
  type EscalationPrice,
  EscalationPriceSchema,
  decisionHash,
  type Evaluation,
  evaluate,
  IdSchema,
  IssuanceRefused,
  REPORT_MAX_AGE_MS,
  type ReasonCode,
  type State,
  type AnyVerificationReport,
  type VerifiedReport,
  parseShelleyAddress,
} from '@authority/core';
import type { Db, StoredEvent } from '@authority/db';
import * as z from 'zod';
import { issueOnce } from './authorize';
import { BOND_ASSET, bondOf, briefFor, escalationsToday, exactRequirements, type PaymentProof, paymentResponse, priceFor, reply402, settleViaFacilitator, withBudget, x402Network } from './escalation';
import type { VerifyFx } from './fx';
import { HttpError, parseJson, type Reply } from './http';
import { idempotent } from './idempotency';
import type { EventLog } from './log';
import { currentMandate, type MandateRow, readChain, vaultSummary } from './mandates';
import type { CardanoPort, Interpret, ReadInvoice, Verify } from './ports';
import { authorizationId, type DecisionContext, receiptBody, storeReceipt } from './receipts';
import { attachRun, createRun, type RunRow } from './runs';

export type Caller = 'agent' | 'masumi';

/** Shared by the check, approval, and lab paths. */
export interface Engine {
  db: Db;
  log: EventLog;
  now: () => number;
  cardano: CardanoPort;
  verify: Verify;
  /** fx_lock: the proposed quote read back from Crebit. Fails closed without keys. */
  verifyFx: VerifyFx;
  readInvoice: ReadInvoice;
  /** mandate id -> engine Ed25519 secret key */
  engineKeys: Map<string, Uint8Array>;
  enqueue: (authorizationId: number) => void;
  interpret: Interpret | null;
  publicApiUrl: string;
  /** Escalation bond in lovelace (ESCALATION_BOND_LOVELACE). */
  bondLovelace: string;
  /** x402 facilitator for exact-scheme locks (X402_FACILITATOR_URL); null = the API submits the signed lock itself. */
  facilitatorUrl: string | null;
}

export interface Proposal {
  action: unknown;
  agent_signature: string | null;
}
export type Emit = (type: string, payload: unknown) => Promise<StoredEvent>;

const FACT_REASONS = new Set([
  'INVOICE_NOT_FOUND',
  'CUSTOMER_MISMATCH',
  'INVOICE_NOT_OPEN',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'RECIPIENT_MISMATCH',
  'VERIFICATION_UNAVAILABLE',
]);
const FX_FACT_REASONS = new Set(['QUOTE_NOT_FOUND', 'RATE_MISMATCH', 'PREMIUM_MISMATCH', 'EXPIRY_MISMATCH', 'QUOTE_OFF_MARKET']);
export const layerOf = (reason: string): Layer => (FACT_REASONS.has(reason) ? 'cre' : FX_FACT_REASONS.has(reason) ? 'crebit' : 'engine');

function isKeyAddress(address: string): boolean {
  try {
    const a = parseShelleyAddress(address);
    return a.payment.tag === 'key' && (a.stake === null || a.stake.tag === 'key');
  } catch {
    return false;
  }
}

export const CheckBodySchema = z
  .strictObject({
    mandate_id: IdSchema,
    proposal: z.strictObject({ action: z.unknown(), agent_signature: z.string().max(256).nullable() }).optional(),
    request_text: z.string().min(1).max(2000).optional(),
    execute: z.boolean().default(false),
    run_id: z.uuid().optional(),
    /** Where a bond refund goes (a key address); lets the 402 carry the complete lock datum (x402 extra.datum). */
    bond_refund_address: z.string().min(1).max(200).refine(isKeyAddress, 'bond_refund_address must be a key address').optional(),
  })
  .refine((b) => (b.proposal === undefined) !== (b.request_text === undefined), 'send exactly one of proposal or request_text');
export type CheckBody = z.infer<typeof CheckBodySchema>;

export type Layer = 'agent' | 'engine' | 'cre' | 'crebit' | 'vault' | 'principal';

export interface Decided {
  evaluation: Evaluation & { outcome: DecisionOutcome };
  verification: { report: AnyVerificationReport; report_hash: string; sepolia_tx: string | null } | null;
  /** The report exactly as verifyInvoice returned it from Sepolia, fresh for this decision (never cached). */
  verified: VerifiedReport | null;
  /** For a DENY: the layer that stopped it. */
  deniedBy: Layer | null;
}

/**
 * A facts-stage denial the API adds on top of the engine: the verified_facts check fails with `reason`, later checks
 * become not_evaluated (DENY short-circuits). Used for the invoice-number check (CRE does not compare numbers) and
 * for an invoice already reserved by another authorization. Never passed to the issuance gate.
 */
export function factsDenial(
  e: Evaluation,
  reason: 'INVOICE_NOT_FOUND' | 'INVOICE_NOT_OPEN',
  detail: Record<string, string | number | boolean | null>,
): Evaluation & { outcome: 'DENY' } {
  return denialAt(e, e.checks.findIndex((c) => c.kind === 'verified_facts'), reason, detail);
}

/** The engine's own budget denial, applied when the day's last slot went to a concurrent escalation after this one was evaluated. */
export function budgetDenial(e: Evaluation, detail: { used: number; per_day: number }): Evaluation & { outcome: 'DENY' } {
  return denialAt(e, e.checks.findIndex((c) => c.id === 'interrupt_budget'), 'INTERRUPT_BUDGET_EXHAUSTED', detail);
}

function denialAt(e: Evaluation, index: number, reason: ReasonCode, detail: Record<string, string | number | boolean | null>): Evaluation & { outcome: 'DENY' } {
  const checks = e.checks.map((c, i) => {
    if (i === index) return { ...c, result: 'fail' as const, reason, detail };
    if (i > index) return { ...c, result: 'not_evaluated' as const, reason: null, detail: {} };
    return c;
  });
  return { ...e, outcome: 'DENY', reason, checks };
}

/**
 * evaluate -> (NEEDS_VERIFICATION: CRE, read back from Sepolia) -> evaluate again. CRE runs only when the engine
 * asks for it, so an action that already failed a DENY constraint never triggers verification.
 */
export async function decide(
  eng: Engine,
  input: { row: MandateRow; proposal: Proposal; state: State; action: ActionIR | null; emit: Emit },
): Promise<Decided> {
  const { row, proposal, state, emit } = input;
  const evaluateNow = async (verification: VerifiedReport | null) => {
    await emit('AuthorityEvaluationStarted', { mandate_id: row.mandate.id, mandate_version: row.mandate.version });
    const evaluation = evaluate({ mandate: row.mandate, proposal, state, verification, nowMs: eng.now() });
    await emit('AuthorityEvaluated', { evaluation });
    return evaluation;
  };
  const final = (e: Evaluation, v: Decided['verification'], deniedBy: Layer | null = null): Decided => {
    if (e.outcome === 'NEEDS_VERIFICATION') throw new Error('unreachable: NEEDS_VERIFICATION is never final');
    const verified = v === null ? null : { report: v.report, report_hash: v.report_hash, block_time_ms: blockTimeMs };
    return { evaluation: e as Decided['evaluation'], verification: v, verified, deniedBy: e.outcome === 'DENY' ? (deniedBy ?? layerOf(e.reason ?? '')) : null };
  };
  let blockTimeMs = 0;
  const first = await evaluateNow(null);
  if (first.outcome !== 'NEEDS_VERIFICATION') return final(first, null);
  const action = input.action;
  if (action?.type === 'fx_lock') return decideFx(eng, { row, proposal, state, action, emit, first, evaluateNow, final });
  if (!action?.reference) {
    await emit('ActionDenied', { reason: 'VERIFICATION_UNAVAILABLE', layer: 'cre' });
    throw new HttpError(422, 'the action has no invoice reference, so its invoice facts cannot be verified');
  }
  let onRecord: { number: string | null } | null;
  try {
    onRecord = await eng.readInvoice(action.reference.invoice_id);
  } catch (error) {
    throw new HttpError(503, `stripe unavailable: ${(error as Error).message}`, { 'retry-after': '10' });
  }
  if (onRecord === null || onRecord.number !== action.reference.invoice_number) {
    const denied = factsDenial(first, 'INVOICE_NOT_FOUND', {
      source: 'stripe',
      invoice_id: action.reference.invoice_id,
      invoice_number: action.reference.invoice_number,
      on_record: onRecord?.number ?? null,
    });
    await emit('AuthorityEvaluated', { evaluation: denied });
    return final(denied, null, 'engine');
  }
  // A live authorization for this exact action already binds one verification report. Re-verifying would return a
  // fresh report whose hash differs from that authorization's verification_ref, so the evidence on record is reused.
  const bound = await boundVerification(eng, row.mandate.id, action.reference.invoice_id, canonicalHash(action));
  if (bound !== null) {
    blockTimeMs = bound.verified.block_time_ms;
    await emit('CREVerificationCompleted', bound.verification);
    const again = await evaluateNow(bound.verified);
    if (again.outcome !== 'NEEDS_VERIFICATION') return final(again, bound.verification);
  }
  const triggerId = randomUUID();
  await emit('CREVerificationStarted', { trigger_id: triggerId });
  const out = await eng.verify(action, triggerId);
  if (out.status === 'reported') {
    const verification = { report: out.verified.report, report_hash: out.verified.report_hash, sepolia_tx: out.tx_hash };
    blockTimeMs = out.verified.block_time_ms;
    await emit('CREVerificationCompleted', verification);
    const second = await evaluateNow(out.verified);
    if (second.outcome !== 'NEEDS_VERIFICATION') return final(second, verification);
  }
  await emit('ActionDenied', { reason: 'VERIFICATION_UNAVAILABLE', layer: 'cre' });
  const why = out.status === 'unavailable' ? out.error : 'the report read back from Sepolia is not usable';
  // The 503 body carries this too, but the agent is the only one who sees that; the operator needs it in the API log.
  console.error(`cre verification unavailable, trigger ${triggerId}: ${why}`);
  throw new HttpError(503, `verification unavailable: ${why}`, { 'retry-after': '30' });
}

/**
 * fx_lock: the quote is read back from Crebit and the report evaluated at once. The report CRE produced when this
 * action was priced (402) is reused on the paid retry, as for invoices.
 */
async function decideFx(
  eng: Engine,
  i: {
    row: MandateRow;
    proposal: Proposal;
    state: State;
    action: ActionIR;
    emit: Emit;
    first: Evaluation;
    evaluateNow: (v: VerifiedReport | null) => Promise<Evaluation>;
    final: (e: Evaluation, v: Decided['verification'], deniedBy?: Layer | null) => Decided;
  },
): Promise<Decided> {
  const { row, action, emit } = i;
  const fx = row.mandate.fx;
  if (!fx) {
    await emit('ActionDenied', { reason: 'FX_NOT_AUTHORIZED', layer: 'engine' });
    throw new HttpError(422, 'this mandate has no fx block, so no rate lock can be verified under it');
  }
  const actionHash = canonicalHash(action);
  const priced = await pricedVerification(eng, row.mandate.id, actionHash);
  if (priced !== null) {
    await emit('QuoteVerificationCompleted', priced.verification);
    const again = await i.evaluateNow(priced.verified);
    if (again.outcome !== 'NEEDS_VERIFICATION') return i.final(again, priced.verification);
  }
  const triggerId = randomUUID();
  await emit('QuoteVerificationStarted', { trigger_id: triggerId, quote_id: action.fx?.quote_id ?? null, source: 'crebit' });
  const out = await eng.verifyFx(action, triggerId, { maxBasisBps: fx.max_basis_bps, decimals: row.mandate.asset.decimals });
  if (out.status === 'reported') {
    const verification = { report: out.verified.report, report_hash: out.verified.report_hash, sepolia_tx: null };
    await emit('QuoteVerificationCompleted', verification);
    const second = await i.evaluateNow(out.verified);
    if (second.outcome !== 'NEEDS_VERIFICATION') return i.final(second, verification);
  }
  await emit('ActionDenied', { reason: 'VERIFICATION_UNAVAILABLE', layer: 'crebit' });
  const why = out.status === 'unavailable' ? out.error : 'the quote report is not usable';
  console.error(`quote verification unavailable, trigger ${triggerId}: ${why}`);
  throw new HttpError(503, `verification unavailable: ${why}`, { 'retry-after': '30' });
}

/** The verification report bound by a live authorization for this action, read back from this log, or null. */
async function boundVerification(
  eng: Engine,
  mandateId: string,
  invoiceId: string,
  actionHash: string,
): Promise<{ verified: VerifiedReport; verification: Decided['verification'] & object } | null> {
  const [row] = await eng.db.query<{ payload: string; created_ms: string }>(
    `select e.payload, (extract(epoch from e.created_at) * 1000)::bigint::text as created_ms
       from invoice_reservations v
       join authorizations a on a.id = v.authorization_id
       join events e on e.run_id = a.run_id and e.action_id = a.action_id and e.type = 'CREVerificationCompleted'
      where v.mandate_id = $1 and v.invoice_id = $2 and a.action_hash = $3
        and a.status in ('issued', 'awaiting_cfo', 'queued', 'submitted') and a.valid_until > $4
        and (e.payload::json ->> 'report_hash') = (a.record::json -> 'fields' ->> 'verification_ref')
      order by e.seq desc limit 1`,
    [mandateId, invoiceId, actionHash, eng.now()],
  );
  if (!row) return pricedVerification(eng, mandateId, actionHash);
  const verification = JSON.parse(row.payload) as { report: AnyVerificationReport; report_hash: string; sepolia_tx: string | null };
  return { verified: { report: verification.report, report_hash: verification.report_hash, block_time_ms: Number(row.created_ms) }, verification };
}

/**
 * The report CRE produced when this action was priced (402). The paid retry is the same action under the same
 * mandate minutes later: the evaluation still applies evaluate()'s freshness window to it, and a stale report
 * triggers a new verification as usual. Saves one Sepolia round trip per escalation.
 */
async function pricedVerification(eng: Engine, mandateId: string, actionHash: string): Promise<Awaited<ReturnType<typeof boundVerification>>> {
  const [row] = await eng.db.query<{ payload: string; created_ms: string }>(
    `select e.payload, (extract(epoch from e.created_at) * 1000)::bigint::text as created_ms
       from approvals ap
       join events e on e.run_id = ap.run_id and e.action_id = ap.action_id and e.type in ('CREVerificationCompleted', 'QuoteVerificationCompleted')
      where ap.mandate_id = $1 and ap.action_hash = $2 and ap.status = 'awaiting_bond'
      order by e.seq desc limit 1`,
    [mandateId, actionHash],
  );
  if (!row) return null;
  const verification = JSON.parse(row.payload) as { report: AnyVerificationReport; report_hash: string; sepolia_tx: string | null };
  if (verification.report.action_hash !== actionHash) return null;
  return { verified: { report: verification.report, report_hash: verification.report_hash, block_time_ms: Number(row.created_ms) }, verification };
}

/** The decision hash of the evaluation this response carries. */
export const responseDecisionHash = (e: Pick<Evaluation, 'action_hash' | 'mandate_hash' | 'verification_hash'> & { outcome: DecisionOutcome }) =>
  decisionHash(e.action_hash, e.mandate_hash, e.verification_hash, e.outcome);

export function decisionContext(
  row: MandateRow,
  action: ActionIR | null,
  proposal: Proposal,
  d: Decided,
  approval: DecisionContext['approval'],
  firstEventHash: string,
): DecisionContext {
  const e = d.evaluation;
  return {
    mandate_version: row.mandate.version,
    action,
    action_hash: e.action_hash,
    agent_signature: proposal.agent_signature,
    evaluation: { outcome: e.outcome, reason: e.reason, checks: e.checks },
    verification: d.verification && {
      report_hash: d.verification.report_hash,
      sepolia_tx: d.verification.sepolia_tx,
      result: d.verification.report.result,
      ...(d.verification.report.schema === 'fx-verification/v0.1' ? { quote_id: d.verification.report.quote_id, quote_hash: d.verification.report.quote_hash } : {}),
    },
    approval,
    first_event_hash: firstEventHash,
  };
}

/** The check pipeline without HTTP or idempotency (used by the Attack Lab for its valid authorizations). */
export async function checkInProcess(eng: Engine, caller: Caller, body: z.input<typeof CheckBodySchema>, payment: PaymentProof | null = null): Promise<Reply> {
  return runCheck(eng, caller, CheckBodySchema.parse(body), payment);
}

async function runCheck(eng: Engine, caller: Caller, body: CheckBody, payment: PaymentProof | null): Promise<Reply> {
  if (caller === 'masumi' && (body.execute || body.run_id !== undefined)) {
    throw new HttpError(403, 'this key may only request evaluations: execute must be false and run_id absent');
  }
  if (caller === 'agent' && body.run_id === undefined) throw new HttpError(400, 'agent checks must name their run_id');
  const row = await currentMandate(eng.db, body.mandate_id);
  if (!row) throw new HttpError(404, `unknown mandate ${body.mandate_id}`);
  const engineKey = eng.engineKeys.get(row.mandate.id);
  if (!engineKey) throw new HttpError(500, `no engine key for ${row.mandate.id}`);

  let interpreted: unknown;
  let proposal: Proposal;
  if (body.request_text !== undefined) {
    if (!eng.interpret) throw new HttpError(501, 'plain-English requests need the interpreter, which is not configured');
    interpreted = await eng.interpret(body.request_text, row.mandate);
    proposal = { action: interpreted, agent_signature: null };
  } else {
    proposal = body.proposal as Proposal;
  }

  const chain = await readChain(eng.cardano, row, eng.now());
  // The interrupt budget is engine state read from the approvals table: escalations whose bond was locked today.
  chain.state = await withBudget(eng.db, row.mandate.id, chain.state, eng.now());
  const run: Pick<RunRow, 'run_id' | 'kind' | 'attack'> =
    body.run_id !== undefined
      ? await attachRun(eng.db, body.run_id, row.mandate.id)
      : {
          run_id: await createRun(eng.db, eng.log, {
            kind: 'masumi',
            row,
            goal: 'Authority Check',
            status: 'finished',
            vault: vaultSummary(chain.vault, eng.now()),
          }),
          kind: 'masumi',
          attack: null,
        };

  const parsed = ActionIRSchema.safeParse(proposal.action);
  const action = parsed.success ? parsed.data : null;
  const trail: StoredEvent[] = [];
  const emit: Emit = async (type, payload) => {
    const event = await eng.log.emit({ run_id: run.run_id, action_id: action?.id ?? null, type, payload });
    trail.push(event);
    return event;
  };
  // An invalid proposal is logged without its body: it may be arbitrarily deep or not even an object.
  const proposed = await emit('ActionProposed', {
    action,
    action_hash: action ? canonicalHash(action) : null,
    agent_signature: proposal.agent_signature,
  });
  let d = await decide(eng, { row, proposal, state: chain.state, action, emit });
  let e: Decided['evaluation'] = d.evaluation;
  let brief: DecisionBrief | null = null;
  let bond: Bond | null = null;
  let price: EscalationPrice | null = null;
  const contextOf = (ev: Decided['evaluation']) =>
    decisionContext(
      row,
      action,
      proposal,
      { ...d, evaluation: ev },
      { required: ev.outcome === 'ESCALATE', cfo_key_hash: null, brief_hash: brief && briefHash(brief), bond: bond && { status: bond.status, tx_hash: bond.tx_hash, outcome_tx_hash: bond.outcome_tx_hash } },
      proposed.hash,
    );
  const denied = async (ev: Decided['evaluation'], layer: Layer | null) => {
    const reason = ev.reason ?? 'INVALID_PROPOSAL';
    await emit('ActionDenied', { reason, layer });
    // Attack Lab outcomes the engine itself decides: a fooled agent, or the fourth escalation of the day.
    const labStop = run.attack?.startsWith('prompt_injection') || (run.attack === 'escalation_spam' && reason === 'INTERRUPT_BUDGET_EXHAUSTED');
    if (run.kind === 'lab' && labStop) {
      await emit('AttackResult', { attack: run.attack, stopped_by: layer, code: reason, funds_moved: '0', tx_hash: null });
    }
  };

  let authorization: { id: number; record: AuthorizationRecord } | null = null;
  let approvalId: string | null = null;
  if (e.outcome === 'DENY') {
    await denied(e, d.deniedBy);
  } else if (e.outcome === 'ESCALATE' && action && e.action_hash !== null && !body.execute) {
    // Evaluate-only callers (Masumi, agent dry runs) learn what interrupting the human costs: the brief and a price
    // quote. No approval exists and no bond is owed; execute: true on this action prices it for real.
    const used = chain.state.escalations_today ?? 0;
    price = priceFor(eng, row, { approvalId: 'quote', actionHash: e.action_hash, approverPkh: chain.anchor.approver_pkh, used });
    brief = briefFor({ action, evaluation: e, row, verification: d.verification, bond: { amount: price.amount, asset: BOND_ASSET }, expiresAtMs: price.locked_until_ms });
  } else if (e.signed && action) {
    if (e.outcome === 'ESCALATE') {
      const gate = await escalationGate(eng, { row, run, action, evaluation: e, proposal, approverPkh: chain.anchor.approver_pkh, verification: d.verification, payment, refundAddress: body.bond_refund_address, emit });
      if (gate.kind === 'priced') return gate.reply;
      if (gate.kind === 'denied') {
        // The bond is locked and comes back at locked_until (expireApprovals); the human is never paged.
        ({ bond } = gate);
        e = gate.evaluation;
        await emit('AuthorityEvaluated', { evaluation: e });
        await denied(e, 'engine');
      } else {
        ({ brief, bond, price } = gate);
        approvalId = gate.approvalId;
      }
    } else {
      if (d.verified && eng.now() - d.verified.block_time_ms > REPORT_MAX_AGE_MS) {
        d = await decide(eng, { row, proposal, state: chain.state, action, emit });
        e = d.evaluation;
      }
      if (e.outcome === 'DENY') {
        await denied(e, d.deniedBy);
      } else if (e.outcome === 'ALLOW' && action.type === 'fx_lock') {
        // No vault authorization: the premium leaves on Crebit's chain by the human's own signature (the funding
        // instruction follows POST /fx/contracts). The decision receipt below is the engine's record of the ALLOW.
        await emit('FxLockAllowed', { quote_id: action.fx?.quote_id ?? null, amount: action.amount.value, asset: action.amount.asset });
      } else if (e.outcome === 'ALLOW') {
        try {
          const out = await issueOnce(eng, {
            row,
            proposal,
            action,
            actionHash: canonicalHash(action),
            state: chain.state,
            verification: d.verified,
            approval: null,
            chainLastNonce: BigInt(chain.state.last_nonce),
            chainReadAtMs: chain.readAtMs,
            engineKey,
            runId: run.run_id,
            approvalId: null,
            context: contextOf(e),
            status: body.execute ? 'queued' : 'issued',
          });
          if (out.kind === 'reserved') {
            // One invoice, one authorization that can ever pay it: a second one is a deterministic DENY.
            e = factsDenial(e, 'INVOICE_NOT_OPEN', { source: 'reservation', authorization_id: authorizationId(out.id), holder: out.reason });
            await emit('AuthorityEvaluated', { evaluation: e });
            await denied(e, 'engine');
          } else {
            authorization = { id: out.id, record: out.record };
            if (out.kind === 'issued') {
              trail.push(out.event);
              if (body.execute) eng.enqueue(out.id);
            } else if (body.execute) {
              // execute:false stored this row as issued. A later execute must queue that same row; the executor ignores issued.
              const queued = await eng.db.query(
                `update authorizations set status = 'queued' where id = $1 and status = 'issued' returning id`,
                [out.id],
              );
              if (queued.length === 1) eng.enqueue(out.id);
            }
          }
        } catch (error) {
          if (error instanceof IssuanceRefused) throw new HttpError(422, error.message);
          throw error;
        }
      }
    }
  }

  const receipt = await storeReceipt(eng.db, {
    kind: 'decision',
    mandateId: row.mandate.id,
    actionId: action?.id ?? null,
    authorizationId: authorization?.id ?? null,
    body: receiptBody(row, contextOf(e), { authorization, settlement: null, last_event_hash: trail.at(-1)!.hash }),
  });
  return {
    status: 200,
    body: {
      run_id: run.run_id,
      evaluation: e,
      ...(interpreted === undefined ? {} : { interpreted_action: interpreted }),
      verification: d.verification && {
        report_hash: d.verification.report_hash,
        sepolia_tx: d.verification.sepolia_tx,
        facts: d.verification.report.facts,
      },
      authorization: authorization?.record ?? null,
      approval_id: approvalId,
      ...(brief === null ? {} : { brief }),
      ...(bond === null ? {} : { bond }),
      ...(price === null || approvalId !== null ? {} : { price, escalation: { price, approval_endpoint: `${eng.publicApiUrl}/v1/authority/check` } }),
      receipt_id: receipt.id,
      receipt_hash: receipt.hash,
      events_url: `${eng.publicApiUrl}/v1/runs/${run.run_id}/events`,
      decision_hash: responseDecisionHash(e),
      ...(e.signed ? {} : { notice: 'unsigned: evaluation only' }),
    },
    ...(bond?.tx_hash && price ? { headers: { 'payment-response': paymentResponse(payment?.exact ? x402Network(price.network) : price.network, bond.tx_hash) } } : {}),
  };
}

type Gate =
  | { kind: 'priced'; reply: Reply }
  | { kind: 'locked'; approvalId: string; price: EscalationPrice; brief: DecisionBrief; bond: Bond }
  | { kind: 'denied'; evaluation: Decided['evaluation'] & { outcome: 'DENY' }; bond: Bond };

/**
 * The 402 gate. An ESCALATE that wants execution first gets an approval row in `awaiting_bond` and its price; the
 * same action asks again and gets the same price until the bond is on chain. With a PAYMENT-SIGNATURE naming
 * that approval, the escrow UTxO is read back from Cardano and checked against the price. Only then is the brief
 * built and the approval made visible to the human (status pending, ApprovalRequested).
 */
async function escalationGate(
  eng: Engine,
  i: {
    row: MandateRow;
    run: Pick<RunRow, 'run_id' | 'kind' | 'attack'>;
    action: ActionIR;
    evaluation: Decided['evaluation'];
    proposal: Proposal;
    approverPkh: string;
    verification: Decided['verification'];
    payment: PaymentProof | null;
    refundAddress: string | undefined;
    emit: Emit;
  },
): Promise<Gate> {
  const { row, run, action, evaluation: e, emit } = i;
  const actionHash = e.action_hash;
  if (actionHash === null) throw new Error('escalationGate: a signed evaluation always carries its action hash');
  const dayIndex = Math.floor(eng.now() / 86_400_000);
  const [existing] = await eng.db.query<{ id: string; price: string }>(
    `select id::text as id, price from approvals where mandate_id = $1 and action_hash = $2 and status = 'awaiting_bond' order by approvals.id desc limit 1`,
    [row.mandate.id, actionHash],
  );
  let id: string;
  let price: EscalationPrice;
  if (existing) {
    id = existing.id;
    price = JSON.parse(existing.price) as EscalationPrice;
  } else {
    const [ap] = await eng.db.query<{ id: string }>(
      `insert into approvals (run_id, mandate_id, action_id, action_hash, proposal, evaluation, status, day_index)
       values ($1, $2, $3, $4, $5, $6, 'awaiting_bond', $7) returning id::text as id`,
      [run.run_id, row.mandate.id, action.id, actionHash, canonicalJson(i.proposal), canonicalJson(e), dayIndex],
    );
    id = ap!.id;
    price = priceFor(eng, row, { approvalId: `AP-${id}`, actionHash, approverPkh: i.approverPkh, used: e.checks.find((c) => c.id === 'interrupt_budget')?.detail.used as number ?? 0 });
    await eng.db.query('update approvals set price = $2, locked_until_ms = $3 where id = $1', [id, canonicalJson(price), price.locked_until_ms]);
    await emit('BondRequired', { approval_id: price.approval_id, price });
    if (run.kind === 'lab' && run.attack === 'no_bond') {
      await emit('AttackResult', { attack: run.attack, stopped_by: 'engine', code: 'BOND_REQUIRED', funds_moved: '0', tx_hash: null });
    }
  }
  const proof = i.payment;
  // An exact-scheme proof is a signed lock nobody has broadcast: submit it first, then read it back like any other.
  const txHash = proof?.approval_id !== price.approval_id ? null : proof.exact ? await submitLock(eng, proof.exact) : proof.tx_hash;
  const utxo = txHash === null ? null : await eng.cardano.readBond(price);
  const valid =
    utxo !== null &&
    utxo.tx_hash === txHash &&
    (proof!.exact !== undefined || utxo.output_index === proof!.output_index) &&
    utxo.datum.action_hash === actionHash &&
    utxo.datum.approver_pkh === price.approver_key_hash &&
    utxo.amount >= BigInt(price.amount);
  if (!valid) return { kind: 'priced', reply: reply402(eng.publicApiUrl, price, action.id, i.refundAddress) };
  const bond = bondOf(price, row.mandate.id, utxo);
  const brief = briefFor({ action, evaluation: e, row, verification: i.verification, bond: { amount: bond.amount, asset: bond.asset }, expiresAtMs: price.locked_until_ms });
  // The engine counted the budget before this bond was read back from Cardano. The claim takes the budget unit under
  // a per-mandate lock, so two escalations racing for the day's last slot cannot both reach the human.
  const perDay = row.mandate.interrupt_budget.per_day;
  const claimed = await eng.db.tx(async (q) => {
    await q.query('select pg_advisory_xact_lock(hashtext($1))', [row.mandate.id]);
    const used = await escalationsToday(q, row.mandate.id, dayIndex);
    if (used >= perDay) {
      await q.query('update approvals set bond = $2 where id = $1 and status = $3', [id, canonicalJson(bond), 'awaiting_bond']);
      return { used };
    }
    const rows = await q.query(
      `update approvals set status = 'pending', proposal = $2, evaluation = $3, brief = $4, brief_hash = $5, bond = $6, day_index = $7
       where id = $1 and status = 'awaiting_bond' returning id`,
      [id, canonicalJson(i.proposal), canonicalJson(e), canonicalJson(brief), briefHash(brief), canonicalJson(bond), dayIndex],
    );
    return rows.length === 0 ? null : { used: null };
  });
  if (claimed === null) throw new HttpError(429, 'this escalation is being settled, retry', { 'retry-after': '1' });
  await emit('BondLocked', { approval_id: bond.approval_id, tx_hash: bond.tx_hash, output_index: bond.output_index, amount: bond.amount, asset: bond.asset });
  if (claimed.used !== null) return { kind: 'denied', evaluation: budgetDenial(e, { used: claimed.used, per_day: perDay }), bond };
  await emit('ApprovalRequested', { approval_id: bond.approval_id, approvals_required: e.approvals_required, brief, bond });
  return { kind: 'locked', approvalId: bond.approval_id, price, brief, bond };
}

/** Broadcasts the exact-scheme lock, through the facilitator when one is configured. The hash to read back, or null when refused. */
async function submitLock(eng: Engine, exact: NonNullable<PaymentProof['exact']>): Promise<string | null> {
  if (eng.facilitatorUrl !== null) {
    const price = exact.payload.accepted.extra.escalation;
    return settleViaFacilitator(eng.facilitatorUrl, exact.payload, exactRequirements(EscalationPriceSchema.parse(price)));
  }
  const r = await eng.cardano.submitSigned(exact.transaction_hex);
  // A node rejection after the lock landed (inputs already spent) is the re-presented payload of a settled lock.
  if (!r.accepted) console.warn(`exact lock ${r.tx_hash} not accepted by the node: ${r.detail.replace(/\s+/g, ' ').slice(0, 160)}`);
  return r.tx_hash;
}

export function handleCheck(eng: Engine, caller: Caller, idempotencyKey: string, rawBody: string, payment: PaymentProof | null): Promise<Reply> {
  return idempotent(eng.db, caller, idempotencyKey, rawBody, async () => {
    const parsed = CheckBodySchema.safeParse(parseJson(rawBody));
    if (!parsed.success) throw new HttpError(400, `invalid request: ${parsed.error.issues.map((i) => i.path.join('.') || i.message).join('; ')}`);
    return runCheck(eng, caller, parsed.data, payment);
  });
}
