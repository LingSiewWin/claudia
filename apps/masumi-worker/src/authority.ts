import { canonicalJson } from '@authority/core';
import { decisionHash } from '@authority/masumi';
import * as z from 'zod';
import type { AuthorityRequest } from './input';

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);

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
  authorization: z
    .looseObject({
      schema: z.literal('authorization/v0.1'),
      fields: z.looseObject({ requires_principal: z.boolean() }),
    })
    .nullable()
    .optional(),
  receipt_id: z.string().min(1),
  receipt_hash: Hex32,
  events_url: z.string(),
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

// Retry-After is either delta-seconds or an HTTP date.
function retryAfterMs(header: string | null, nowMs = Date.now()): number | null {
  if (header === null) return null;
  const v = header.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

// The API answered, but with something that must never be sold as a result.
export class AuthorityContractError extends Error {}

export interface AuthorityClient {
  check(request: AuthorityRequest, idempotencyKey: string): Promise<AuthorityResponse>;
}

export function createAuthorityClient(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): AuthorityClient {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/authority/check`;
  const send = opts.fetchImpl ?? fetch;
  return {
    async check(request, idempotencyKey) {
      const res = await send(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'idempotency-key': idempotencyKey,
          'content-type': 'application/json',
        },
        // A Masumi check returns a decision; it never asks the API to execute a payment.
        body: JSON.stringify({ ...request, execute: false }),
      });
      if (!res.ok) {
        throw new AuthorityError(`authority check HTTP ${res.status}`, res.status, retryAfterMs(res.headers.get('retry-after')));
      }
      const parsed = AuthorityResponseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new AuthorityContractError('authority check response does not match the contract');
      return parsed.data;
    },
  };
}

export interface AuthorityOutput {
  output: Record<string, unknown>;
  resultText: string;
}

// The sold result. resultText (RFC 8785 JSON) is the exact string that is hashed, submitted and delivered.
export function buildOutput(res: AuthorityResponse, publicWebUrl: string): AuthorityOutput {
  const e = res.evaluation;
  const authorization = res.authorization ?? null;
  if (authorization !== null) {
    if (!e.signed) throw new AuthorityContractError('authorization returned for an unsigned proposal');
    if (e.outcome === 'DENY') throw new AuthorityContractError('authorization returned for a DENY');
    if (e.outcome === 'REQUIRE_APPROVAL' && authorization.fields.requires_principal !== true) {
      throw new AuthorityContractError('REQUIRE_APPROVAL authorization must require the principal signature');
    }
  }
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
