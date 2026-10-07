import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const shipped = ['app', 'components', 'lib', 'src', 'hooks'];
// Root-level files Next.js loads on its own (not the config files, which run at build time only).
const rootShipped = /^(middleware|proxy|instrumentation|instrumentation-client)\.(ts|tsx|js|mjs)$/;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const rootFiles = existsSync(root) ? readdirSync(root).filter((n) => rootShipped.test(n)).map((n) => join(root, n)) : [];
const sources = [...shipped.flatMap((d) => files(join(root, d))), ...rootFiles].map((p) => ({ p, text: readFileSync(p, 'utf8') }));
const secretNames = readFileSync(join(root, '../../.env.example'), 'utf8')
  .split('\n')
  .map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1])
  .filter((n): n is string => n !== undefined && !n.startsWith('NEXT_PUBLIC_'));

describe('the web app holds public values only', () => {
  it('reads no environment variable except NEXT_PUBLIC_*', () => {
    // Any env access that is not a direct NEXT_PUBLIC_* read: dot, bracket, optional chaining, aliasing, destructuring, import.meta.
    const envAccess = /(?:process|import\s*\.\s*meta)\s*(?:\?\.|\.)\s*env(?![A-Za-z0-9_$])|process\s*(?:\?\.)?\s*\[\s*['"`]env['"`]\s*\]/g;
    const destructured = /\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/g;
    const publicRead = /^\s*(?:(?:\?\.|\.)\s*NEXT_PUBLIC_[A-Z0-9_]+|\??\.?\s*\[\s*['"`]NEXT_PUBLIC_[A-Z0-9_]+['"`]\s*\])/;
    const offenders = sources.flatMap(({ p, text }) => [
      ...[...text.matchAll(envAccess)]
        .filter((m) => !publicRead.test(text.slice(m.index + m[0].length)))
        .map((m) => `${p}: ${text.slice(m.index, m.index + 40).split('\n')[0]}`),
      ...[...text.matchAll(destructured)].map((m) => `${p}: ${m[0]}`),
    ]);
    expect(offenders).toEqual([]);
  });

  it('never names a server secret (engine keys, M-001 keys, wallet recovery phrases, API keys)', () => {
    expect(secretNames.length).toBeGreaterThan(5);
    const named = (text: string, n: string) => new RegExp(`(?<![A-Z0-9_])${n}(?![A-Z0-9_])`).test(text);
    const hits = sources.flatMap(({ p, text }) => secretNames.filter((n) => named(text, n)).map((n) => `${p}: ${n}`));
    expect(hits).toEqual([]);
  });
});
