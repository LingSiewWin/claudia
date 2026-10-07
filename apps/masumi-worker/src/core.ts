import * as z from 'zod';

// Sokosumi Core runtime API, authenticated as the Coworker (Bearer coworker_*), never as a user.
export const SOKOSUMI_PREPROD_API = 'https://api.preprod.sokosumi.com';

const TaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  assigneeId: z.string().nullable(),
  organizationId: z.string().nullable(),
});
export type CoreTask = z.infer<typeof TaskSchema>;

const ReceiptSchema = z.object({
  blockchainIdentifier: z.string().nullable(),
  claimStatus: z.string().nullable(),
  onChainState: z.string().nullable(),
  settled: z.boolean(),
  txHash: z.string().nullable(),
});
export type CoreReceipt = z.infer<typeof ReceiptSchema>;

const EventSchema = z.object({ id: z.string(), status: z.string().nullable().optional(), comment: z.string().nullable().optional() });
export type CoreEvent = z.infer<typeof EventSchema>;

const Page = z.object({
  data: z.unknown(),
  meta: z.object({ pagination: z.object({ nextCursor: z.string().nullable() }).optional() }).optional(),
});

export class CoreError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface CoreClient {
  me(): Promise<{ id: string; capabilities: string[]; archivedAt: string | null }>;
  readyTasks(): Promise<CoreTask[]>;
  getTask(taskId: string): Promise<CoreTask>;
  postEvent(taskId: string, body: Record<string, unknown>): Promise<{ id: string }>;
  receipt(taskId: string): Promise<CoreReceipt>;
  events(taskId: string): Promise<CoreEvent[]>;
}

export function createCoreClient(opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }): CoreClient {
  if (!/^coworker_[A-Za-z0-9_-]+$/.test(opts.apiKey)) throw new Error('SOKOSUMI_COWORKER_API_KEY must be a coworker_* key');
  const base = (opts.baseUrl ?? SOKOSUMI_PREPROD_API).replace(/\/+$/, '');
  const send = opts.fetchImpl ?? fetch;
  const request = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<z.infer<typeof Page>> => {
    const res = await send(`${base}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const kind = (json as { kind?: unknown } | null)?.kind;
      throw new CoreError(`Sokosumi ${method} ${path.split('?')[0]} HTTP ${res.status}${typeof kind === 'string' ? ` (${kind})` : ''}`, res.status);
    }
    return Page.parse(json);
  };
  const task = (taskId: string): string => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
    return `/v1/tasks/${taskId}`;
  };
  const pages = async <T>(path: string, schema: z.ZodType<T>): Promise<T[]> => {
    const out: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const page = await request('GET', `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      out.push(...z.array(schema).parse(page.data));
      cursor = page.meta?.pagination?.nextCursor ?? null;
      if (cursor !== null) {
        if (seen.has(cursor)) throw new Error('Sokosumi repeated a pagination cursor');
        seen.add(cursor);
      }
    } while (cursor !== null);
    return out;
  };
  return {
    async me() {
      const data = (await request('GET', '/v1/coworkers/me')).data;
      return z.object({ id: z.string(), capabilities: z.array(z.string()), archivedAt: z.string().nullable() }).parse(data);
    },
    readyTasks: () => pages('/v1/tasks?status=READY', TaskSchema),
    async getTask(taskId) {
      return TaskSchema.parse((await request('GET', task(taskId))).data);
    },
    async postEvent(taskId, body) {
      return EventSchema.parse((await request('POST', `${task(taskId)}/events`, body)).data);
    },
    async receipt(taskId) {
      return ReceiptSchema.parse((await request('GET', `${task(taskId)}/receipt`)).data);
    },
    events: (taskId) => pages(`${task(taskId)}/events`, EventSchema),
  };
}
