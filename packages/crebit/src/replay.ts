import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transport, TransportRequest } from './client';

/*
 * Replay transport for tests: serves the example responses copied verbatim from the partner reference
 * (fixtures/reference-*.json). Each fixture names the route it answers. This is recorded documentation, not a
 * live Crebit: nothing it returns is evidence of anything, and nothing outside tests may use it.
 */

export interface ReplayFixture {
  route: string; // "GET /fx/quotes/{id}" style; {x} matches one path segment
  status: number;
  body: unknown;
}

export const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

export function loadReferenceFixtures(dir = FIXTURES_DIR): ReplayFixture[] {
  return readdirSync(dir)
    .filter((f) => /^reference-.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ReplayFixture);
}

const matches = (route: string, req: TransportRequest) => {
  const [method, pattern] = route.split(' ') as [string, string];
  if (method !== req.method) return false;
  const path = new URL(req.url).pathname.replace(/^\/api\/v1/, '');
  const re = new RegExp(`^${pattern.replace(/\{[^}]+\}/g, '[^/]+')}$`);
  return re.test(path);
};

export function replayTransport(fixtures: ReplayFixture[] = loadReferenceFixtures()): Transport & { calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const t = (async (req: TransportRequest) => {
    calls.push(req);
    const hit = fixtures.find((f) => matches(f.route, req));
    if (!hit) return { status: 404, body: JSON.stringify({ code: 'not_found', message: `replay: no fixture for ${req.method} ${req.url}`, details: {} }) };
    return { status: hit.status, body: JSON.stringify(hit.body) };
  }) as Transport & { calls: TransportRequest[] };
  t.calls = calls;
  return t;
}
