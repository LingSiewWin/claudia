import { setTimeout as sleep } from 'node:timers/promises';
import { guardModel, modelFromEnv, secretsFromEnv } from '@authority/llm';
import { listOpenInvoices, readOnlyStripe } from '@authority/stripe';
import { httpAuthority } from './authority';
import { cardanoBondPayer, newEscalationState } from './bond';
import { loadConfig } from './config';
import { runClaimed } from './runtime';

// The agent process: claims pending runs from the Authority API and works them with the configured model.
// Usage: pnpm --filter @authority/agent start   (add --once to work a single run and exit)
const config = loadConfig(process.env);
const model = guardModel(modelFromEnv(process.env), secretsFromEnv(process.env));
const stripe = readOnlyStripe(config.stripeReadKey);
const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
const deps = {
  authority: httpAuthority({ url: config.apiUrl, key: config.apiKey }),
  model,
  invoices: { listOpen: () => listOpenInvoices(stripe, config.customerId) },
  agentKeys: config.agentKeys,
  now: Date.now,
  sleep: (ms: number) => sleep(ms),
  pollMs: config.pollMs,
  resolveTimeoutMs: config.resolveTimeoutMs,
  maxTurns: config.maxTurns,
  payer: cardanoBondPayer(process.env),
  maxBondLovelace: config.maxBondLovelace,
  escalation: newEscalationState(),
  log,
};
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => void (stopping = true));
process.on('SIGTERM', () => void (stopping = true));

log({ event: 'agent_started', provider: model.provider, model: model.modelId, api: config.apiUrl, mandates: [...config.agentKeys.keys()] });
while (!stopping) {
  const claim = await deps.authority.claim().catch((error: unknown) => {
    log({ event: 'claim_failed', error: (error as Error).message });
    return null;
  });
  if (claim) {
    await runClaimed(deps, claim).catch((error: unknown) => log({ event: 'run_failed', run_id: claim.run_id, error: (error as Error).message }));
    if (once) break;
  } else {
    await sleep(config.pollMs);
  }
}
