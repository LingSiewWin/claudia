import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export const MAX_BODY_BYTES = 64 * 1024;

export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

export function send(res: ServerResponse, reply: Reply, cors: Record<string, string>): void {
  if (reply.status === 204) {
    res.writeHead(204, { ...cors, ...reply.headers }).end();
    return;
  }
  res.writeHead(reply.status, { 'content-type': 'application/json', ...cors, ...reply.headers });
  res.end(JSON.stringify(reply.body));
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Returns the caller whose key matches the Bearer token. Constant-time per key. */
export function bearer<C extends string>(req: IncomingMessage, keys: Partial<Record<C, string | undefined>>): C {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    for (const [caller, key] of Object.entries(keys) as [C, string | undefined][]) {
      if (key && timingSafeEqual(digest(key), digest(token))) return caller;
    }
  }
  throw new HttpError(401, 'missing or unknown API key');
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_.-]{1,200}$/;

export function idempotencyKey(req: IncomingMessage): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
    throw new HttpError(400, 'Idempotency-Key header must be 1-200 characters of A-Z a-z 0-9 : _ . -');
  }
  return key;
}
