// Runs the ready examples and one plain-English request through the real Authority API twice each (same
// Idempotency-Key), prints the decisions, and records src/demo.json for GET /demo.
// Usage: pnpm --filter @authority/masumi-worker smoke:api
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOutput, createAuthorityClient } from '../src/authority';
import { loadConfig } from '../src/config';
import { parseAuthorityInput } from '../src/input';

const examples = JSON.parse(readFileSync(fileURLToPath(new URL('../src/examples.json', import.meta.url)), 'utf8')) as Record<string, unknown>;
const cfg = loadConfig(process.env);
const client = createAuthorityClient({ baseUrl: cfg.authorityApiUrl, apiKey: cfg.authorityApiKey, enginePublicKey: cfg.enginePublicKey });
const run = randomUUID().slice(0, 8);
const cases: [string, unknown][] = [...Object.entries(examples), ['text', { mandate_id: 'M-001', request_text: 'Pay AWS invoice INV-M-0001' }]];
const results: Record<string, string> = {};
for (const [name, raw] of cases) {
  const request = parseAuthorityInput(raw);
  const key = `smoke:${run}:${name}`;
  const first = buildOutput(await client.check(request, key), cfg.publicWebUrl);
  const again = buildOutput(await client.check(request, key), cfg.publicWebUrl);
  const o = first.output as { decision: string; reason: string | null; notice?: string; authorization: { fields: { requires_principal: boolean; nonce: string } } | null; receipt: unknown; decision_hash: string };
  results[name] = first.resultText;
  console.log(JSON.stringify({
    case: name,
    decision: o.decision,
    reason: o.reason,
    notice: o.notice ?? null,
    authorization: o.authorization ? { requires_principal: o.authorization.fields.requires_principal, nonce: o.authorization.fields.nonce } : null,
    receipt: o.receipt,
    decision_hash: o.decision_hash,
    idempotent: first.resultText === again.resultText,
  }));
}
const demo = { input: examples.allow, output: { result: results.allow }, examples: [examples.allow, examples.require_approval, examples.deny] };
writeFileSync(fileURLToPath(new URL('../src/demo.json', import.meta.url)), `${JSON.stringify(demo, null, 2)}\n`);
console.log('wrote src/demo.json');
