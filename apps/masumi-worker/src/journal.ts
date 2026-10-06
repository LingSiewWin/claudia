import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const KEY = /^[A-Za-z0-9_-]{1,128}$/;
const LEASE_SETTLE_MS = 25;

type Lease = { owner: string; renewedAt: number; generation: string };

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

const fsyncPath = (path: string): void => {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const writeDurable = (tmp: string, value: unknown): void => {
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncPath(dirname(tmp));
};

const writeJson = (path: string, value: unknown): void => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeDurable(tmp, value);
  renameSync(tmp, path);
  fsyncPath(dirname(path));
};

const writeExclusive = (path: string, value: unknown): boolean => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeDurable(tmp, value);
  try {
    linkSync(tmp, path);
    fsyncPath(dirname(path));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* leftover tmp is ignored by keys() */
    }
  }
};

const settle = (): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LEASE_SETTLE_MS);
};

const parseLease = (raw: unknown): Lease | 'malformed' => {
  if (raw === null || typeof raw !== 'object') return 'malformed';
  const rec = raw as Record<string, unknown>;
  if (typeof rec.owner !== 'string' || rec.owner.length === 0) return 'malformed';
  if (typeof rec.renewedAt !== 'number' || !Number.isFinite(rec.renewedAt)) return 'malformed';
  if (rec.generation !== undefined && (typeof rec.generation !== 'string' || rec.generation.length === 0)) {
    return 'malformed';
  }
  return {
    owner: rec.owner,
    renewedAt: rec.renewedAt,
    generation: typeof rec.generation === 'string' ? rec.generation : '',
  };
};

const readLease = (path: string): Lease | 'malformed' | null => {
  const raw = readJson<unknown>(path);
  return raw === null ? null : parseLease(raw);
};

// One JSON file per purchase. Stages are written before each external call, so a restart resumes
// from the last durable stage. The temp file and its directory are fsynced before rename, and the
// directory is fsynced after, so a host crash cannot lose a stage written before an external call.
export class Journal<T extends object> {
  readonly dir: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
  }
  read(key: string): T | null {
    return readJson<T>(this.path(key));
  }
  write(key: string, value: T): void {
    writeJson(this.path(key), value);
  }
  keys(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
  }
  private path(key: string): string {
    if (!KEY.test(key)) throw new Error(`unsafe journal key: ${key}`);
    return join(this.dir, `${key.toLowerCase()}.json`);
  }
}

export const LEASE_TTL_MS = 60_000;

// Single executor per state directory, also across containers sharing one volume: the holder renews
// every poll; another process takes over only after the lease is LEASE_TTL_MS old.
export function tryAcquireLease(dir: string, owner: string, nowMs: number): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'lease.json');
  const current = readLease(path);
  if (current === 'malformed') return false;
  if (current && current.owner !== owner && nowMs - current.renewedAt < LEASE_TTL_MS) return false;
  const generation = !current || current.owner !== owner ? randomUUID() : current.generation || randomUUID();
  const next = { owner, renewedAt: nowMs, generation };
  if (!current) {
    if (!writeExclusive(path, next)) return false;
    return holdGeneration(dir) === generation;
  }
  writeJson(path, next);
  if (current.owner !== owner) settle();
  return holdGeneration(dir) === generation;
}

export function holdGeneration(dir: string): string | null {
  const current = readLease(join(dir, 'lease.json'));
  if (current === null || current === 'malformed' || current.generation.length === 0) return null;
  return current.generation;
}
