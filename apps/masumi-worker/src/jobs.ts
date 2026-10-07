import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  MpsError,
  QuoteError,
  checkQuote,
  confirmedState,
  isPurchaserId,
  mip004InputHash,
  mip004ResultHashEscaped,
  paymentRequest,
  resultRecorded,
  type MpsClient,
  type Payment,
  type SellerSource,
} from '@authority/masumi';
import { AuthorityContractError, AuthorityError, buildOutput, type AuthorityClient } from './authority';
import { INPUT_SCHEMA, InputError, parseAuthorityInput, type AuthorityRequest } from './input';
import { holdGeneration, type Journal } from './journal';

const MINUTE = 60_000;
const MAX_BODY_BYTES = 16_384;
const CREATE_ATTEMPTS = 8;
const RETRY_BACKOFF_MS = 0;
const TERMINAL_PAYMENT = new Set(['FundsOrDatumInvalid', 'RefundRequested']);
// Recorded by scripts/smoke-api.ts from a real Authority API run.
export const DEMO_FILE = fileURLToPath(new URL('./demo.json', import.meta.url));

export type JobStage =
  | 'quote-pending'
  | 'awaiting-payment'
  | 'authority-pending'
  | 'result-saved'
  | 'submit-pending'
  | 'completed'
  | 'failed'
  | 'needs-inspection';

export interface JobRecord {
  id: string;
  identifier: string;
  inputHash: string;
  request: AuthorityRequest;
  stage: JobStage;
  payment?: Payment;
  response?: Record<string, unknown>;
  resultText?: string;
  resultHash?: string;
  error?: string;
  retryNotBefore?: number;
  createRetryable?: boolean;
}

export type Log = (msg: string, data?: Record<string, unknown>) => void;

export interface JobDeps {
  jobs: Journal<JobRecord>;
  mps: MpsClient;
  authority: AuthorityClient;
  source: SellerSource | null;
  webUrl: string;
  now: () => number;
  log: Log;
  // Generation captured after the executor acquired the lease. Null means no hold.
  // A string is refused once holdGeneration(leaseDir) differs.
  leaseDir: string;
  generation: string | null;
  wait?: (ms: number) => Promise<void>;
}

const MIP003_STATUS: Record<JobStage, string> = {
  'quote-pending': 'awaiting_payment',
  'awaiting-payment': 'awaiting_payment',
  'authority-pending': 'running',
  'result-saved': 'running',
  'submit-pending': 'running',
  completed: 'completed',
  failed: 'failed',
  'needs-inspection': 'failed',
};

const ACTIVE: ReadonlySet<JobStage> = new Set([
  'quote-pending',
  'awaiting-payment',
  'authority-pending',
  'result-saved',
  'submit-pending',
]);

type Reply = { status: number; body: unknown };

const waitFor = (deps: JobDeps, ms: number): Promise<void> => (deps.wait ?? ((n) => new Promise((r) => setTimeout(r, n))))(ms);

const lostHold = (deps: JobDeps): boolean => deps.generation === null || holdGeneration(deps.leaseDir) !== deps.generation;

const inspect = (job: JobRecord, deps: JobDeps, error: string): JobRecord => {
  const next = { ...job, stage: 'needs-inspection' as const, error, createRetryable: false };
  deps.jobs.write(job.identifier, next);
  deps.log('job needs inspection', { jobId: job.id, error });
  return next;
};

function classifyCreate(e: unknown): 'retry' | 'failed' | 'needs-inspection' {
  if (e instanceof MpsError) {
    if (e.status === 408 || e.status === 429) return 'retry';
    if (e.uncertain) return 'needs-inspection';
    return 'failed';
  }
  return 'needs-inspection';
}

// POST /start_job. Idempotent per identifier_from_purchaser: a retry returns the stored terms and
// never requests a second payment. The identifier is lowercased before journal keying.
export async function startJob(raw: unknown, deps: JobDeps): Promise<Reply> {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as { identifier_from_purchaser?: unknown; input_data?: unknown };
  const rawId = body.identifier_from_purchaser;
  if (typeof rawId !== 'string' || !isPurchaserId(rawId)) {
    return { status: 400, body: { error: 'identifier_from_purchaser must be 14-26 hex characters' } };
  }
  const identifier = rawId.toLowerCase();
  let request: AuthorityRequest;
  try {
    request = parseAuthorityInput(body.input_data);
  } catch (e) {
    if (e instanceof InputError) return { status: 400, body: { error: e.message } };
    throw e;
  }
  if (deps.source === null) return { status: 503, body: { error: 'payment registration is not confirmed yet' } };
  const inputHash = mip004InputHash(body.input_data, identifier);
  const existing = deps.jobs.read(identifier);
  let job: JobRecord;
  if (existing) {
    if (existing.inputHash !== inputHash) return { status: 409, body: { error: 'identifier_from_purchaser was already used with a different input' } };
    if (existing.response) return { status: 200, body: existing.response };
    if (existing.stage === 'quote-pending' && existing.createRetryable) {
      job = { ...existing, createRetryable: false };
      deps.jobs.write(identifier, job);
    } else if (existing.stage === 'quote-pending' || existing.stage === 'needs-inspection') {
      const inspected = existing.stage === 'needs-inspection' ? existing : inspect(existing, deps, 'payment request outcome unknown after a restart');
      return { status: 409, body: { error: inspected.error ?? 'an earlier request with this identifier did not finish; use a new identifier' } };
    } else {
      return { status: 409, body: { error: 'an earlier request with this identifier did not finish; use a new identifier' } };
    }
  } else {
    job = { id: randomUUID(), identifier, inputHash, request, stage: 'quote-pending' };
    deps.jobs.write(identifier, job);
  }
  const quoteRequest = paymentRequest(deps.source, inputHash, identifier, deps.now());
  let payment: Payment | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    if (lostHold(deps)) {
      inspect(job, deps, 'lease generation changed before the payment request');
      return { status: 502, body: { error: 'payment service request failed' } };
    }
    try {
      const created = await deps.mps.createPayment(quoteRequest);
      checkQuote(created, deps.source, quoteRequest);
      payment = created;
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      if (e instanceof QuoteError) {
        inspect(job, deps, String(e));
        return { status: 502, body: { error: 'payment service request failed' } };
      }
      if (classifyCreate(e) === 'retry') {
        await waitFor(deps, RETRY_BACKOFF_MS);
        continue;
      }
      break;
    }
  }
  if (!payment) {
    const kind = classifyCreate(lastErr);
    if (kind === 'retry') {
      const pending = { ...job, stage: 'quote-pending' as const, createRetryable: true, error: String(lastErr) };
      deps.jobs.write(identifier, pending);
      deps.log('start_job payment request retryable', { jobId: job.id, error: String(lastErr) });
      return { status: 502, body: { error: 'payment service request failed' } };
    }
    const stage = kind === 'failed' ? 'failed' : 'needs-inspection';
    deps.jobs.write(identifier, { ...job, stage, error: String(lastErr), createRetryable: false });
    deps.log('start_job payment request failed', { jobId: job.id, error: String(lastErr) });
    return { status: 502, body: { error: 'payment service request failed' } };
  }
  const response = {
    id: job.id,
    blockchainIdentifier: payment.blockchainIdentifier,
    payByTime: Number(payment.payByTime),
    submitResultTime: Number(payment.submitResultTime),
    unlockTime: Number(payment.unlockTime),
    externalDisputeUnlockTime: Number(payment.externalDisputeUnlockTime),
    agentIdentifier: payment.agentIdentifier,
    sellerVKey: deps.source.sellerVkey,
    identifierFromPurchaser: identifier,
    input_hash: inputHash,
    paymentSourceType: 'Web3CardanoV2',
    supportedPaymentSourceIndex: deps.source.supportedPaymentSourceIndex,
  };
  job = { ...job, stage: 'awaiting-payment', payment, response, createRetryable: false };
  deps.jobs.write(identifier, job);
  return { status: 200, body: response };
}

// GET /status?job_id=. ponytail: linear scan over job files; index by id if job counts grow.
export function jobStatus(jobId: string, deps: Pick<JobDeps, 'jobs'>): Reply {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) return { status: 400, body: { error: 'job_id must be an id returned by /start_job' } };
  for (const key of deps.jobs.keys()) {
    const found = deps.jobs.read(key);
    if (found?.id === jobId) {
      return { status: 200, body: { status: MIP003_STATUS[found.stage], ...(found.stage === 'completed' ? { result: found.resultText } : {}) } };
    }
  }
  return { status: 404, body: { error: 'job not found' } };
}

// One step-loop per job: each stage is saved before the external call it guards.
export async function advanceJob(start: JobRecord, deps: JobDeps): Promise<JobRecord> {
  let job = start;
  const save = (patch: Partial<JobRecord>): void => {
    job = { ...job, ...patch };
    deps.jobs.write(job.identifier, job);
  };
  if (job.stage === 'quote-pending') {
    if (job.createRetryable) return job;
    return inspect(job, deps, 'payment request outcome unknown after a restart');
  }
  const payment = job.payment;
  if (!payment) return job;
  const submitBy = Number(payment.submitResultTime);
  try {
    for (;;) {
      switch (job.stage) {
        case 'awaiting-payment': {
          const p = await deps.mps.resolvePayment(payment.blockchainIdentifier);
          if (p.onChainState !== null && TERMINAL_PAYMENT.has(p.onChainState)) {
            save({ stage: 'failed', error: `payment ended in ${p.onChainState}` });
            return job;
          }
          if (!confirmedState(p, 'FundsLocked')) {
            if (deps.now() > Number(payment.payByTime) + 10 * MINUTE && p.onChainState === null) save({ stage: 'failed', error: 'not paid before payByTime' });
            return job;
          }
          save({ stage: 'authority-pending' });
          continue;
        }
        case 'authority-pending': {
          if (job.retryNotBefore !== undefined && deps.now() < job.retryNotBefore) return job;
          if (deps.now() >= submitBy - 2 * MINUTE) {
            save({ stage: 'failed', error: 'result deadline reached before the check ran; the escrow refunds the buyer' });
            return job;
          }
          if (lostHold(deps)) return inspect(job, deps, 'lease generation changed before the authority check');
          const { resultText } = buildOutput(await deps.authority.check(job.request, `masumi:${job.identifier}`, { deadlineMs: submitBy, nowMs: deps.now() }), deps.webUrl);
          save({ stage: 'result-saved', resultText, resultHash: mip004ResultHashEscaped(resultText, job.identifier) });
          continue;
        }
        case 'result-saved':
        case 'submit-pending': {
          const hash = job.resultHash;
          if (!hash) throw new Error('journal has no result hash');
          const current = await deps.mps.resolvePayment(payment.blockchainIdentifier);
          if (!resultRecorded(current, hash)) {
            if (current.resultHash) {
              save({ stage: 'needs-inspection', error: 'payment already carries a different result hash' });
              return job;
            }
            if (deps.now() + 2 * MINUTE >= submitBy) {
              save({ stage: 'failed', error: 'result deadline passed before submission' });
              return job;
            }
            if (lostHold(deps)) return inspect(job, deps, 'lease generation changed before submit-result');
            save({ stage: 'submit-pending' });
            await deps.mps.submitResult(payment.blockchainIdentifier, hash);
          }
          save({ stage: 'completed' });
          deps.log('job completed', { jobId: job.id, resultHash: hash });
          return job;
        }
        default:
          return job;
      }
    }
  } catch (e) {
    if (e instanceof AuthorityContractError || (e instanceof AuthorityError && !e.transient)) {
      save({ stage: 'failed', error: e.message });
    } else if (e instanceof AuthorityError && e.transient) {
      const delay = Math.max(e.retryAfterMs ?? 0, RETRY_BACKOFF_MS);
      if (delay > 0) save({ retryNotBefore: deps.now() + delay });
      deps.log('job step failed; retrying next poll', { jobId: job.id, stage: job.stage, error: String(e) });
    } else {
      deps.log('job step failed; retrying next poll', { jobId: job.id, stage: job.stage, error: String(e) });
    }
    return job;
  }
}

export async function advanceJobs(deps: JobDeps): Promise<void> {
  for (const key of deps.jobs.keys()) {
    let found: JobRecord | null;
    try {
      found = deps.jobs.read(key);
    } catch (e) {
      deps.log('job record unreadable', { identifier: key, error: String(e) });
      continue;
    }
    if (found && ACTIVE.has(found.stage)) await advanceJob(found, deps);
  }
}

interface Demo {
  input: { proposal?: unknown };
  output: { result: string };
  examples: unknown[];
}

const readDemo = (file: string): Demo | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Demo) : null);

// The ALLOW example is the proposal field's default, so buyers see a working input.
function inputSchema(demo: Demo | null) {
  if (!demo?.input.proposal) return INPUT_SCHEMA;
  const example = JSON.stringify(demo.input.proposal);
  return { input_data: INPUT_SCHEMA.input_data.map((f) => (f.id === 'proposal' ? { ...f, data: { ...f.data, default: example } } : f)) };
}

// MIP-003 HTTP API: /availability, /input_schema, /start_job, /status, /demo.
export function createMip003Handler(deps: JobDeps, demoFile: string = DEMO_FILE): (req: IncomingMessage, res: ServerResponse) => void {
  const inflight = new Set<string>();
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/availability') {
      return send(res, 200, { status: 'available', type: 'masumi-agent', message: 'Human Authority Endpoint is ready' });
    }
    if (req.method === 'GET' && url.pathname === '/input_schema') return send(res, 200, inputSchema(readDemo(demoFile)));
    if (req.method === 'GET' && url.pathname === '/demo') {
      const demo = readDemo(demoFile);
      return demo ? send(res, 200, demo) : send(res, 404, { error: 'no demo recorded yet' });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      const r = jobStatus(url.searchParams.get('job_id') ?? '', deps);
      return send(res, r.status, r.body);
    }
    if (req.method === 'POST' && url.pathname === '/start_job') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return send(res, 413, { error: 'request body too large' });
        chunks.push(chunk as Buffer);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'request body must be JSON' });
      }
      const id = (parsed as { identifier_from_purchaser?: unknown } | null)?.identifier_from_purchaser;
      const key = typeof id === 'string' ? id.toLowerCase() : null;
      if (key !== null && inflight.has(key)) return send(res, 409, { error: 'a request with this identifier is in progress' });
      if (key !== null) inflight.add(key);
      try {
        const r = await startJob(parsed, deps);
        return send(res, r.status, r.body);
      } finally {
        if (key !== null) inflight.delete(key);
      }
    }
    return send(res, 404, { error: 'not found' });
  };
  return (req, res) => {
    route(req, res).catch((e: unknown) => {
      deps.log('mip-003 request failed', { error: String(e) });
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  };
}
