import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { PRICE_UNITS, TEST_USDM_UNIT, createMpsClient, verifyCollection } from '@authority/masumi';
import { createAuthorityClient } from './authority';
import { loadConfig } from './config';
import { createCoreClient } from './core';
import { advanceJobs, createMip003Handler, type JobRecord } from './jobs';
import { Journal, holdGeneration, tryAcquireLease } from './journal';
import { pollTasks, type TaskRecord } from './tasks';

const POLL_MS = 10_000;
const cfg = loadConfig(process.env);
const log = (msg: string, data: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...data }));
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const owner = `${hostname()}:${process.pid}:${randomUUID()}`;

while (!tryAcquireLease(cfg.stateDir, owner, Date.now())) {
  log('another executor holds the lease; waiting');
  await sleep(POLL_MS);
}
const generation = holdGeneration(cfg.stateDir);
if (generation === null) throw new Error('lease acquired without a generation');

const base = {
  mps: createMpsClient({ baseUrl: cfg.paymentServiceUrl, token: cfg.paymentApiKey }),
  authority: createAuthorityClient({ baseUrl: cfg.authorityApiUrl, apiKey: cfg.authorityApiKey, enginePublicKey: cfg.enginePublicKey }),
  source: cfg.source,
  webUrl: cfg.publicWebUrl,
  now: Date.now,
  log,
  leaseDir: cfg.stateDir,
  generation,
};
const jobDeps = { ...base, jobs: new Journal<JobRecord>(join(cfg.stateDir, 'jobs')) };

const sokosumi = cfg.sokosumi;
const taskDeps = sokosumi
  ? {
      ...base,
      core: createCoreClient({ apiKey: sokosumi.apiKey }),
      tasks: new Journal<TaskRecord>(join(cfg.stateDir, 'tasks')),
      coworkerId: sokosumi.coworkerId,
      paid: cfg.paidTasks,
      verifyCollection: (txHash: string, sellerAddress: string, binding: { inputHash: string; paymentTxHashes: readonly string[] }) => {
        const source = cfg.source;
        if (source === null) throw new Error('collection proof needs a confirmed registration');
        return verifyCollection({
          txHash,
          sellerAddress,
          escrowAddress: source.smartContractAddress,
          unit: TEST_USDM_UNIT,
          minUnits: BigInt(PRICE_UNITS),
          inputHash: binding.inputHash,
          paymentTxHashes: binding.paymentTxHashes,
          blockfrostKey: cfg.blockfrostKey,
        });
      },
    }
  : null;
if (taskDeps) {
  const me = await taskDeps.core.me();
  if (me.id !== taskDeps.coworkerId || me.archivedAt !== null || !me.capabilities.includes('tasks')) {
    throw new Error('the coworker key does not belong to SOKOSUMI_COWORKER_ID or lacks the tasks capability');
  }
}

createServer(createMip003Handler(jobDeps)).listen(cfg.port, cfg.host, () => {
  log('worker started', { host: cfg.host, port: cfg.port, registered: cfg.source !== null, tasks: taskDeps !== null, paidTasks: cfg.paidTasks });
});

for (;;) {
  if (!tryAcquireLease(cfg.stateDir, owner, Date.now())) {
    log('lease lost to another executor; exiting');
    process.exit(1);
  }
  const held = holdGeneration(cfg.stateDir);
  if (held === null) {
    log('lease has no generation; exiting');
    process.exit(1);
  }
  jobDeps.generation = held;
  if (taskDeps) taskDeps.generation = held;
  await advanceJobs(jobDeps);
  if (taskDeps) await pollTasks(taskDeps).catch((e: unknown) => log('task poll failed', { error: String(e) }));
  await sleep(POLL_MS);
}
