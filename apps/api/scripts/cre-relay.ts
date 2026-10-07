// Runs CRE verification jobs for a hosted API from a machine with the CRE CLI login.
// The API chose every payload (including trigger_id) and reads the result from Sepolia itself.
// Usage: pnpm --filter @authority/api cre-relay   (env: AUTHORITY_API_URL, CRE_RELAY_KEY; optional CRE_BIN)
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { simulateBroadcast, type TriggerPayload } from '@authority/chainlink';

const api = process.env.AUTHORITY_API_URL?.replace(/\/+$/, '');
const key = process.env.CRE_RELAY_KEY;
if (!api || !key) throw new Error('AUTHORITY_API_URL and CRE_RELAY_KEY are required');
const root = resolve(import.meta.dirname, '../../..');
const simulate = simulateBroadcast({
  workflowsDir: resolve(root, 'workflows'),
  envFile: resolve(root, '.env'),
  creBin: process.env.CRE_BIN ?? 'cre',
});
const post = (path: string, body: unknown) =>
  fetch(`${api}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

console.log(`cre relay polling ${api}`);
for (;;) {
  let res: Response;
  try {
    res = await post('/v1/cre/jobs/claim', {});
  } catch (error) {
    console.log(`claim failed: ${(error as Error).message}`);
    await sleep(5_000);
    continue;
  }
  if (res.status !== 200) {
    if (res.status !== 204) console.log(`claim: HTTP ${res.status}`);
    await sleep(2_000);
    continue;
  }
  const job = (await res.json()) as { trigger_id: string; payload: TriggerPayload };
  console.log(`job ${job.trigger_id}: invoice ${job.payload.invoice_id}`);
  let output: string;
  try {
    output = await simulate(job.payload);
  } catch (error) {
    output = `relay: simulate failed: ${(error as Error).message}`;
  }
  const tx = /InvoiceVerified tx=(0x[0-9a-fA-F]{64})/.exec(output)?.[1] ?? 'none';
  const done = await post(`/v1/cre/jobs/${job.trigger_id}/result`, { output: output.slice(-900_000) });
  console.log(`job ${job.trigger_id}: tx ${tx}, posted ${done.status}`);
}
