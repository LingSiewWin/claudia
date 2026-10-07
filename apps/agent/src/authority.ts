import type { Mandate } from '@authority/core';

// The agent's view of the Authority API. The agent holds a bearer key for these routes and nothing that can
// authorize or move funds: authorizations come only from the engine's key, settlements only from the vault.

export class AuthorityError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterS: number | null,
  ) {
    super(message);
    this.name = 'AuthorityError';
  }
  /** 429 and 503 are retried with the same idempotency key; any other error is final. */
  get transient() {
    return this.status === 429 || this.status === 503;
  }
}

export interface Claim {
  run_id: string;
  kind: 'stage' | 'lab';
  mandate_id: string;
  goal: string;
  attack: string | null;
}

export type WorkItem = { kind: 'invoice'; invoice_number: string } | { kind: 'request'; message_id: string };

export interface InboxMessage {
  id: string;
  kind: 'vendor_email' | 'internal_request';
  from: string;
  subject: string;
  body: string;
  received_at: string;
}

export interface RunWork {
  run_id: string;
  queue: WorkItem[];
  messages: InboxMessage[];
}

export interface MandateView {
  mandate: Mandate;
  mandate_hash: string;
  limits: { symbol: string; decimals: number; autonomous_limit: string; hard_cap: string; daily_cap: string; treasury_minimum: string };
  vault: { balance: string; spent_today: string; day_index: number; last_nonce: string };
}

export interface Decision {
  receipt_id: string;
  action_id: string;
  type: string;
  counterparty_id: string;
  invoice_number: string | null;
  amount: string;
  outcome: string;
  reason: string | null;
  created_at: string;
}

export interface CheckReply {
  run_id: string | null;
  evaluation: { outcome: string; reason: string | null };
  verification: { report_hash: string; sepolia_tx: string } | null;
  authorization: { digest_hex: string } | null;
  approval_id: string | null;
  receipt_id: string;
  receipt_hash: string;
  notice?: string;
}

export interface RunEvent {
  seq: number;
  type: string;
  action_id: string | null;
  payload: Record<string, unknown> | null;
}

export interface AuthorityClient {
  claim(): Promise<Claim | null>;
  finish(runId: string): Promise<void>;
  work(runId: string): Promise<RunWork>;
  mandate(mandateId: string): Promise<MandateView>;
  decisions(mandateId: string): Promise<Decision[]>;
  check(body: { mandate_id: string; proposal: { action: unknown; agent_signature: string }; execute: boolean; run_id: string }, idempotencyKey: string): Promise<CheckReply>;
  events(runId: string): Promise<RunEvent[]>;
}

export function httpAuthority(o: { url: string; key: string; timeoutMs?: number; fetch?: typeof fetch }): AuthorityClient {
  const doFetch = o.fetch ?? fetch;
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T | null> => {
    const res = await doFetch(`${o.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 600_000),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const retry = Number(res.headers.get('retry-after'));
      const message = (json as { error?: unknown } | null)?.error;
      throw new AuthorityError(res.status, `${method} ${path}: ${typeof message === 'string' ? message : `HTTP ${res.status}`}`, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    return json as T;
  };
  const must = <T>(v: T | null, what: string): T => {
    if (v === null) throw new AuthorityError(502, `${what}: empty response`, null);
    return v;
  };
  return {
    claim: () => call<Claim>('POST', '/v1/agent/runs/claim', {}),
    finish: async (runId) => void (await call('POST', `/v1/agent/runs/${runId}/finish`, {})),
    work: async (runId) => must(await call<RunWork>('GET', `/v1/agent/runs/${runId}/work`), 'work'),
    mandate: async (id) => must(await call<MandateView>('GET', `/v1/mandates/${encodeURIComponent(id)}`), 'mandate'),
    decisions: async (id) => must(await call<{ decisions: Decision[] }>('GET', `/v1/agent/decisions?mandate_id=${encodeURIComponent(id)}`), 'decisions').decisions,
    check: async (body, key) => must(await call<CheckReply>('POST', '/v1/authority/check', body, { 'idempotency-key': key }), 'check'),
    events: async (runId) => must(await call<{ events: RunEvent[] }>('GET', `/v1/runs/${runId}/log`), 'log').events,
  };
}

/** Retries 429/503 (honoring Retry-After, capped) up to `attempts` times; everything else is thrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, o: { attempts: number; sleep: (ms: number) => Promise<void>; maxWaitMs?: number }): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof AuthorityError) || !error.transient || attempt >= o.attempts) throw error;
      await o.sleep(Math.min((error.retryAfterS ?? 2 ** attempt) * 1000, o.maxWaitMs ?? 120_000));
    }
  }
}
