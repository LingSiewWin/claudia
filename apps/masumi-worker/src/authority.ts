import {
  ActionTypeSchema,
  canonicalJson,
  type DecisionBrief,
  EscalationPriceSchema,
  formatUnits,
  ReasonCodeSchema,
  verifyAuthorizationRecord,
} from '@authority/core';
import { decisionHash } from '@authority/masumi';
import * as z from 'zod';
import type { AuthorityRequest } from './input';

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const Hex28 = z.string().regex(/^[0-9a-f]{56}$/);
const U64Text = z.string().regex(/^[1-9][0-9]{0,19}$/);

// The engine's signed record, exactly as the core issues it: no field missing, none added.
const AuthorizationRecordSchema = z.strictObject({
  schema: z.literal('authorization/v0.1'),
  message_hex: z.string().regex(/^(?:[0-9a-f]{2}){1,512}$/),
  digest_hex: Hex32,
  signature_hex: z.string().regex(/^[0-9a-f]{128}$/),
  engine_public_key: Hex32,
  fields: z.strictObject({
    chain_tag: z.union([z.literal(0), z.literal(1)]),
    vault_hash: Hex28,
    mandate_ref: Hex28,
    mandate_hash: Hex32,
    mandate_version: z.number().int(),
    action_hash: Hex32,
    action_type: z.number().int(),
    asset_policy: Hex28,
    asset_name: z.string().regex(/^(?:[0-9a-f]{2}){0,32}$/),
    amount: U64Text,
    recipient: z.string().min(1).max(200),
    nonce: U64Text,
    valid_until: z.number().int().positive(),
    requires_principal: z.boolean(),
    verification_ref: Hex32.nullable(),
  }),
});

const Units = z.string().regex(/^\d{1,20}$/);
const Outcome = z.enum(['ALLOW', 'ESCALATE', 'DENY']);

// brief/v0.1 exactly as @authority/core builds it (the `satisfies` line fails typecheck if the two drift).
export const DecisionBriefSchema = z.strictObject({
  schema: z.literal('brief/v0.1'),
  action_id: z.string().min(1),
  action_hash: Hex32,
  requested_by: z.string().min(1),
  mandate: z.strictObject({ id: z.string().min(1), version: z.number().int(), hash: Hex32 }),
  what: z.strictObject({
    type: ActionTypeSchema,
    amount: z.strictObject({ value: Units, asset: z.string().min(1), display: z.string().min(1) }),
    counterparty: z.strictObject({ id: z.string().min(1), display: z.string().min(1) }),
    recipient: z.string().min(1),
    reference: z.strictObject({ invoice_id: z.string().min(1), invoice_number: z.string().min(1) }).nullable(),
  }),
  why: z.string(),
  engine: z.strictObject({
    outcome: Outcome,
    reason: ReasonCodeSchema.nullable(),
    checks: z.array(z.strictObject({ id: z.string(), kind: z.string(), result: z.string(), reason: ReasonCodeSchema.nullable() })),
  }),
  escalation: z
    .strictObject({ approver: z.string().min(1), because: z.array(z.strictObject({ constraint: z.string(), reason: ReasonCodeSchema })) })
    .nullable(),
  verified: z
    .strictObject({
      report_hash: Hex32,
      sepolia_tx: z.string().nullable(),
      result: z.enum(['VERIFIED', 'MISMATCH']),
      facts: z.strictObject({
        exists: z.boolean(),
        customer_match: z.boolean(),
        status_open: z.boolean(),
        amount_match: z.boolean(),
        currency_match: z.boolean(),
        recipient_match: z.boolean(),
      }),
    })
    .nullable(),
  limits: z.strictObject({ autonomous_limit: Units, hard_cap: Units, daily_cap: Units, treasury_minimum: Units }),
  will_happen: z.string().min(1),
  expires_at_ms: z.number().int().positive(),
  cost: z.strictObject({
    bond: z.strictObject({ amount: Units, asset: z.string().min(1) }).nullable(),
    interrupt_budget: z.strictObject({ used: z.number().int().min(0), per_day: z.number().int().min(0) }),
  }),
}) satisfies z.ZodType<DecisionBrief>;

// What interrupting the human costs and where the buyer's agent retries once the bond is locked.
export const EscalationSchema = z.strictObject({ price: EscalationPriceSchema, approval_endpoint: z.url() });
export type Escalation = z.infer<typeof EscalationSchema>;

// The slice of POST /v1/authority/check (Authority API) this worker depends on.
export const AuthorityResponseSchema = z.object({
  evaluation: z.object({
    outcome: z.enum(['ALLOW', 'ESCALATE', 'DENY']),
    reason: z.string().nullable(),
    checks: z.array(z.unknown()),
    signed: z.boolean(),
    action_hash: Hex32.nullable(),
    mandate_hash: Hex32,
    verification_hash: Hex32.nullable(),
  }),
  interpreted_action: z.unknown().optional(),
  verification: z
    .object({ report_hash: Hex32, sepolia_tx: z.string(), facts: z.record(z.string(), z.unknown()) })
    .nullable()
    .optional(),
  authorization: AuthorizationRecordSchema.nullable().optional(),
  // v2: the decision brief (any outcome) and, on ESCALATE, the bond price and endpoint (no 402 for this key).
  brief: DecisionBriefSchema.nullable().optional(),
  escalation: EscalationSchema.nullable().optional(),
  receipt_id: z.string().min(1),
  receipt_hash: Hex32,
  events_url: z.string(),
  // Additive Phase 7 field. When present it must match the worker-computed hash.
  decision_hash: Hex32.optional(),
});
export type AuthorityResponse = z.infer<typeof AuthorityResponseSchema>;

export class AuthorityError extends Error {
  readonly status: number;
  // The server's Retry-After hint, when it sent one.
  readonly retryAfterMs: number | null;
  constructor(message: string, status: number, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  // 408, 429 and 5xx may succeed on retry (the API never stores them under an Idempotency-Key). Other 4xx are final.
  get transient(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// Retry-After is either delta-seconds or an HTTP date. A wait never points past the caller's deadline.
function retryAfterMs(header: string | null, deadlineMs: number | undefined, nowMs = Date.now()): number | null {
  if (header === null) return null;
  const v = header.trim();
  let wait: number;
  if (/^\d{1,12}$/.test(v)) wait = Number(v) * 1000;
  else if (HTTP_DATE.test(v) && !Number.isNaN(Date.parse(v))) wait = Math.max(0, Date.parse(v) - nowMs);
  else return null;
  return deadlineMs === undefined ? wait : Math.min(wait, Math.max(0, deadlineMs - nowMs));
}

// The API answered, but with something that must never be sold as a result.
export class AuthorityContractError extends Error {}

export interface AuthorityClient {
  // deadlineMs: when the result must be delivered; Retry-After hints are clamped to it.
  check(request: AuthorityRequest, idempotencyKey: string, opts?: { deadlineMs?: number; nowMs?: number }): Promise<AuthorityResponse>;
}

const signedByAgent = (r: AuthorityRequest) => 'proposal' in r && typeof r.proposal.agent_signature === 'string';

// An authorization is sold only if it is the engine's own signature over this evaluation of this request.
function verifyResponse(res: AuthorityResponse, request: AuthorityRequest, enginePublicKey: string): void {
  if (!signedByAgent(request)) {
    if (res.evaluation.signed) throw new AuthorityContractError('signed evaluation returned for a request without an agent signature');
    if (res.authorization) throw new AuthorityContractError('authorization returned for a request without an agent signature');
  }
  assertSellable(res);
  if (res.authorization && !verifyAuthorizationRecord(res.authorization, enginePublicKey)) {
    throw new AuthorityContractError('authorization does not verify against the pinned engine key');
  }
  const computed = decisionHash(res.evaluation.action_hash, res.evaluation.mandate_hash, res.evaluation.verification_hash, res.evaluation.outcome);
  if (res.decision_hash !== undefined && res.decision_hash !== computed) {
    throw new AuthorityContractError('decision_hash does not match the evaluation');
  }
}

export function createAuthorityClient(opts: {
  baseUrl: string;
  apiKey: string;
  // The mandate's authority_engine.public_key (bare hex or "ed25519:<hex>").
  enginePublicKey: string;
  fetchImpl?: typeof fetch;
}): AuthorityClient {
  const enginePublicKey = opts.enginePublicKey.replace(/^ed25519:/, '');
  if (!/^[0-9a-f]{64}$/.test(enginePublicKey)) throw new TypeError('enginePublicKey: expected 32 bytes of lowercase hex');
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/authority/check`;
  const send = opts.fetchImpl ?? fetch;
  return {
    async check(request, idempotencyKey, checkOpts) {
      const res = await send(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'idempotency-key': idempotencyKey,
          'content-type': 'application/json',
        },
        // A Masumi check returns a decision; it never asks the API to execute a payment.
        body: JSON.stringify({ ...request, execute: false }),
      });
      if (!res.ok) {
        const wait = retryAfterMs(res.headers.get('retry-after'), checkOpts?.deadlineMs, checkOpts?.nowMs);
        throw new AuthorityError(`authority check HTTP ${res.status}`, res.status, wait);
      }
      const parsed = AuthorityResponseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new AuthorityContractError('authority check response does not match the contract');
      verifyResponse(parsed.data, request, enginePublicKey);
      return parsed.data;
    },
  };
}

function assertSellable(res: AuthorityResponse): void {
  const e = res.evaluation;
  const brief = res.brief ?? null;
  if (brief !== null) {
    if (brief.action_hash !== e.action_hash) throw new AuthorityContractError('brief is for another action');
    if (brief.mandate.hash !== e.mandate_hash) throw new AuthorityContractError('brief is under another mandate');
    if (brief.engine.outcome !== e.outcome) throw new AuthorityContractError('brief describes another outcome');
  }
  const escalation = res.escalation ?? null;
  if (e.outcome === 'ESCALATE' && escalation === null) {
    throw new AuthorityContractError('ESCALATE without the bond price: the buyer cannot be told what interrupting the human costs');
  }
  if (e.outcome !== 'ESCALATE' && escalation !== null) throw new AuthorityContractError('bond price returned for a decision that interrupts nobody');
  if (escalation !== null && escalation.price.action_hash !== e.action_hash) throw new AuthorityContractError('bond price is for another action');
  const authorization = res.authorization ?? null;
  if (authorization === null) {
    if (e.signed && e.outcome === 'ALLOW') {
      throw new AuthorityContractError('signed ALLOW without an authorization record');
    }
    return;
  }
  if (!e.signed) throw new AuthorityContractError('authorization returned for an unsigned proposal');
  if (e.outcome === 'DENY') throw new AuthorityContractError('authorization returned for a DENY');
  if (e.outcome === 'ESCALATE' && authorization.fields.requires_principal !== true) {
    throw new AuthorityContractError('ESCALATE authorization must require the principal signature');
  }
  if (authorization.fields.action_hash !== e.action_hash) throw new AuthorityContractError('authorization is for another action');
  if (authorization.fields.mandate_hash !== e.mandate_hash) throw new AuthorityContractError('authorization is under another mandate');
  // A present report is the binding; otherwise the evaluation's verification hash.
  const boundRef = res.verification != null ? res.verification.report_hash : e.verification_hash;
  if (authorization.fields.verification_ref !== boundRef) throw new AuthorityContractError('authorization is for another verification');
}

export interface AuthorityOutput {
  output: Record<string, unknown>;
  resultText: string;
}

// ponytail: only ADA is formatted; other bond assets print base units until the price carries decimals.
const priceDisplay = (p: Escalation['price']): string =>
  p.asset.symbol === 'ADA' ? `${formatUnits(p.amount, 6)} ADA` : `${p.amount} ${p.asset.symbol} (base units)`;

// The lines a human reads in the Task thread. Deterministic: built only from the brief and the price.
export function renderSummary(outcome: AuthorityResponse['evaluation']['outcome'], brief: DecisionBrief | null, escalation: Escalation | null): string {
  const lines: string[] = [];
  if (brief === null) {
    lines.push(
      outcome === 'ALLOW'
        ? 'ALLOW: within the mandate. No human is interrupted.'
        : outcome === 'DENY'
          ? 'DENY: outside the mandate. No human is interrupted.'
          : 'ESCALATE: a named human must sign.',
    );
  } else {
    const w = brief.what;
    const ref = w.reference ? ` for invoice ${w.reference.invoice_number}` : '';
    lines.push(`${outcome}: ${w.amount.display} to ${w.counterparty.display}${ref}, requested by ${brief.requested_by} under mandate ${brief.mandate.id} v${brief.mandate.version}.`);
    lines.push(`Why: ${brief.why}`);
    const v = brief.verified;
    lines.push(
      v === null
        ? 'Verified: no external facts were needed.'
        : `Verified: invoice facts ${v.result}${v.sepolia_tx ? ` (Sepolia ${v.sepolia_tx})` : ''}; report ${v.report_hash}.`,
    );
    if (outcome === 'ESCALATE' && brief.escalation) {
      const because = brief.escalation.because.map((b) => `${b.constraint}: ${b.reason}`).join('; ');
      lines.push(`Why a human: ${brief.escalation.approver} must sign because ${because}.`);
    } else {
      lines.push(outcome === 'DENY' ? `Why denied: ${brief.engine.reason ?? 'engine'}.` : 'Why no human: every mandate check passed.');
    }
    lines.push(`What will happen: ${brief.will_happen}`);
    const b = brief.cost.interrupt_budget;
    if (escalation === null) lines.push(`Cost of interrupting: none. Interrupt budget used ${b.used}/${b.per_day} today.`);
  }
  if (escalation !== null) {
    const p = escalation.price;
    lines.push(
      `Cost of interrupting: lock a ${priceDisplay(p)} bond at ${p.escrow_address} (approval ${p.approval_id}, held until ${new Date(p.locked_until_ms).toISOString()}),` +
        ` then POST ${escalation.approval_endpoint} with the x402 PAYMENT-SIGNATURE header. Interrupt budget used ${p.interrupt_budget.used}/${p.interrupt_budget.per_day} today.`,
    );
    lines.push('The bond is refunded when the human approves or declines a reasonable ask; it is captured only if the ask is marked frivolous. Only the human signature moves funds.');
  }
  return lines.join('\n');
}

// The sold result. resultText (RFC 8785 JSON) is the exact string that is hashed, submitted and delivered.
export function buildOutput(res: AuthorityResponse, publicWebUrl: string): AuthorityOutput {
  assertSellable(res);
  const e = res.evaluation;
  const authorization = res.authorization ?? null;
  const v = res.verification ?? null;
  const brief = res.brief ?? null;
  const escalation = res.escalation ?? null;
  const output: Record<string, unknown> = {
    decision: e.outcome,
    summary: renderSummary(e.outcome, brief, escalation),
    brief,
    escalation,
    reason: e.reason,
    checks: e.checks,
    interpreted_action: res.interpreted_action ?? null,
    verification: v === null ? null : { report_hash: v.report_hash, sepolia_tx: v.sepolia_tx, facts: v.facts },
    authorization,
    receipt: {
      id: res.receipt_id,
      url: `${publicWebUrl.replace(/\/+$/, '')}/receipt/${encodeURIComponent(res.receipt_id)}`,
      hash: res.receipt_hash,
    },
    decision_hash: decisionHash(e.action_hash, e.mandate_hash, e.verification_hash, e.outcome),
    ...(e.signed ? {} : { notice: 'unsigned: evaluation only' }),
  };
  return { output, resultText: canonicalJson(output) };
}
