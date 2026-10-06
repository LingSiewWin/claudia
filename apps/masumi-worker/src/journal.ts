import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = /^[A-Za-z0-9_-]{1,128}$/;

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

const writeJson = (path: string, value: unknown): void => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path); // atomic replace
};

// One JSON file per purchase. Stages are written before each external call, so a restart resumes
// from the last durable stage. ponytail: no fsync; a crash can lose the last write, which the
// stage recovery rules treat like an uncertain call.
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
    return join(this.dir, `${key}.json`);
  }
}

export const LEASE_TTL_MS = 60_000;

// Single executor per state directory, also across containers sharing one volume: the holder renews
// every poll; another process takes over only after the lease is LEASE_TTL_MS old.
export function tryAcquireLease(dir: string, owner: string, nowMs: number): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'lease.json');
  const current = readJson<{ owner: string; renewedAt: number }>(path);
  if (current && current.owner !== owner && nowMs - current.renewedAt < LEASE_TTL_MS) return false;
  writeJson(path, { owner, renewedAt: nowMs });
  return readJson<{ owner: string }>(path)?.owner === owner;
}
