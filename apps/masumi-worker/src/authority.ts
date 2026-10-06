import { canonicalJson, verifyAuthorizationRecord } from '@authority/core';
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

// The slice of POST /v1/authority/check (Authority API) this worker depends on.
export const AuthorityResponseSchema = z.object({
  evaluation: z.object({
    outcome: z.enum(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']),
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
  check(request: AuthorityRequest, idempotencyKey: string, opts?: { deadlineMs?: number }): Promise<AuthorityResponse>;
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
        const wait = retryAfterMs(res.headers.get('retry-after'), checkOpts?.deadlineMs);
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
  const authorization = res.authorization ?? null;
  if (authorization === null) {
    if (e.signed && e.outcome === 'ALLOW') {
      throw new AuthorityContractError('signed ALLOW without an authorization record');
    }
    return;
  }
  if (!e.signed) throw new AuthorityContractError('authorization returned for an unsigned proposal');
  if (e.outcome === 'DENY') throw new AuthorityContractError('authorization returned for a DENY');
  if (e.outcome === 'REQUIRE_APPROVAL' && authorization.fields.requires_principal !== true) {
    throw new AuthorityContractError('REQUIRE_APPROVAL authorization must require the principal signature');
  }
  if (authorization.fields.action_hash !== e.action_hash) throw new AuthorityContractError('authorization is for another action');
  if (authorization.fields.mandate_hash !== e.mandate_hash) throw new AuthorityContractError('authorization is under another mandate');
}

export interface AuthorityOutput {
  output: Record<string, unknown>;
  resultText: string;
}

// The sold result. resultText (RFC 8785 JSON) is the exact string that is hashed, submitted and delivered.
export function buildOutput(res: AuthorityResponse, publicWebUrl: string): AuthorityOutput {
  assertSellable(res);
  const e = res.evaluation;
  const authorization = res.authorization ?? null;
  const v = res.verification ?? null;
  const output: Record<string, unknown> = {
    decision: e.outcome,
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
