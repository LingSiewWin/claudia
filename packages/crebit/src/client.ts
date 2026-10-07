import { randomUUID } from 'node:crypto';
import type * as z from 'zod';
import {
  type Contract,
  type ContractRequest,
  ContractRequestSchema,
  ContractSchema,
  type ContractStatusView,
  ContractStatusViewSchema,
  type CrebitEnv,
  CrebitEnvSchema,
  type CustomerReference,
  CustomerReferenceSchema,
  PageSchema,
  type PartnerMe,
  PartnerMeSchema,
  type Quote,
  type QuoteRequest,
  QuoteRequestSchema,
  QuoteSchema,
  type SupportedChains,
  SupportedChainsSchema,
  type WebhookEvent,
  WebhookEventSchema,
} from './types';

// One request() wrapper (reference 12): three auth headers on every call, Idempotency-Key on every write,
// the error envelope parsed into CrebitError. Responses are validated at this boundary; money stays a string.

export const BASE_URLS: Record<CrebitEnv, string> = {
  sandbox: 'https://lock-apis-sandbox.crebitpay.com',
  production: 'https://lock-apis.crebitpay.com',
};
export const ENV_NAMES = ['CREBIT_ENV', 'CREBIT_KEY_ID', 'CREBIT_KEY_SECRET'] as const;

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body: string | null;
}
export interface TransportResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export class CrebitError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(`crebit ${status} ${code}: ${message}`);
    this.name = 'CrebitError';
  }
}

export interface CrebitConfig {
  env: CrebitEnv;
  keyId: string;
  keySecret: string;
  /** Overrides the base URL for the env (tests, proxies). */
  baseUrl?: string;
  transport?: Transport;
  actingAsPartnerId?: string;
  newIdempotencyKey?: () => string;
}

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, ...(req.body === null ? {} : { body: req.body }) });
  return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers.entries()) };
};

export class CrebitClient {
  readonly env: CrebitEnv;
  readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly newKey: () => string;
  constructor(private readonly cfg: CrebitConfig) {
    this.env = cfg.env;
    this.baseUrl = (cfg.baseUrl ?? BASE_URLS[cfg.env]).replace(/\/+$/, '');
    this.transport = cfg.transport ?? fetchTransport;
    this.newKey = cfg.newIdempotencyKey ?? randomUUID;
  }

  async request<T extends z.ZodType>(method: TransportRequest['method'], path: string, schema: T, o: { body?: unknown; idempotencyKey?: string } = {}): Promise<z.infer<T>> {
    const headers: Record<string, string> = {
      'X-Crebit-Key-Id': this.cfg.keyId,
      'X-Crebit-Key-Secret': this.cfg.keySecret,
      'X-Crebit-Environment': this.env,
      Accept: 'application/json',
    };
    if (this.cfg.actingAsPartnerId) headers['X-Crebit-Acting-As-Partner-Id'] = this.cfg.actingAsPartnerId;
    let body: string | null = null;
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = o.idempotencyKey ?? this.newKey();
      body = JSON.stringify(o.body ?? {});
    }
    const res = await this.transport({ method, url: `${this.baseUrl}/api/v1${path}`, headers, body });
    let json: unknown = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      throw new CrebitError(res.status, 'invalid_json', `non-JSON body from ${method} ${path}`);
    }
    if (res.status >= 400) {
      const env = (json ?? {}) as { code?: string; message?: string; details?: unknown };
      throw new CrebitError(res.status, env.code ?? 'http_error', env.message ?? `${method} ${path} failed`, env.details ?? null);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new CrebitError(res.status, 'unexpected_shape', `${method} ${path}: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    return parsed.data;
  }

  me(): Promise<PartnerMe> {
    return this.request('GET', '/partners/me', PartnerMeSchema);
  }
  supportedChains(): Promise<SupportedChains> {
    return this.request('GET', '/fx/supported-chains', SupportedChainsSchema);
  }
  /** 201 first time, 200 after (naturally idempotent). */
  createCustomerReference(customerReferenceId: string): Promise<CustomerReference> {
    return this.request('POST', '/fx/customer-references', CustomerReferenceSchema, { body: { customer_reference_id: customerReferenceId }, idempotencyKey: `custref:${customerReferenceId}` });
  }
  async createQuote(req: QuoteRequest, idempotencyKey?: string): Promise<Quote> {
    return this.request('POST', '/fx/quotes', QuoteSchema, { body: QuoteRequestSchema.parse(req), ...(idempotencyKey ? { idempotencyKey } : {}) });
  }
  /** Deterministic read of a quote (what a verifier fetches). null when Crebit has no such quote. */
  async getQuote(quoteId: string): Promise<Quote | null> {
    try {
      return await this.request('GET', `/fx/quotes/${encodeURIComponent(quoteId)}`, QuoteSchema);
    } catch (error) {
      if (error instanceof CrebitError && error.status === 404) return null;
      throw error;
    }
  }
  async createContract(req: ContractRequest, idempotencyKey?: string): Promise<Contract> {
    return this.request('POST', '/fx/contracts', ContractSchema, { body: ContractRequestSchema.parse(req), ...(idempotencyKey ? { idempotencyKey } : {}) });
  }
  getContract(contractId: string): Promise<Contract> {
    return this.request('GET', `/fx/contracts/${encodeURIComponent(contractId)}`, ContractSchema);
  }
  contractStatus(contractId: string): Promise<ContractStatusView> {
    return this.request('GET', `/fx/contracts/${encodeURIComponent(contractId)}/status`, ContractStatusViewSchema);
  }
  webhookEvents(o: { direction?: 'incoming' | 'outgoing'; fx_contract_id?: string; cursor?: string; limit?: number } = {}): Promise<{ items: WebhookEvent[]; next_cursor: string | null }> {
    const q = new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));
    const qs = q.size ? `?${q}` : '';
    return this.request('GET', `/fx/webhook-events${qs}`, PageSchema(WebhookEventSchema));
  }
}

/** Env names that are missing or empty (reference 12 names). Empty means the client can be built. */
export function missingCrebitEnv(env: Record<string, string | undefined> = process.env): string[] {
  return ENV_NAMES.filter((name) => !env[name]?.trim());
}

/** A client from CREBIT_ENV / CREBIT_KEY_ID / CREBIT_KEY_SECRET, or null when any is unset. Never a fake. */
export function crebitFromEnv(env: Record<string, string | undefined> = process.env, transport?: Transport): CrebitClient | null {
  if (missingCrebitEnv(env).length > 0) return null;
  const parsed = CrebitEnvSchema.safeParse(env.CREBIT_ENV!.trim());
  if (!parsed.success) throw new Error('CREBIT_ENV must be sandbox or production');
  return new CrebitClient({ env: parsed.data, keyId: env.CREBIT_KEY_ID!.trim(), keySecret: env.CREBIT_KEY_SECRET!.trim(), ...(env.CREBIT_BASE_URL?.trim() ? { baseUrl: env.CREBIT_BASE_URL.trim() } : {}), ...(transport ? { transport } : {}) });
}
