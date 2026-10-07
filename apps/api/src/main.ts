// Authority API: check, approvals, executor, evidence log, SSE. Usage: pnpm --filter @authority/api start
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createCardanoPort, createLabRunner } from '@authority/cardano';
import { simulateBroadcast, verificationRequestFor, verifyInvoice } from '@authority/chainlink';
import { migrate, pgDb } from '@authority/db';
import { getInvoice, listOpenInvoices, readOnlyStripe } from '@authority/stripe';
import { markPaidOutOfBand } from '@authority/stripe/vendor';
import Stripe from 'stripe';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { createApp } from './app';
import type { Engine } from './check';
import { loadConfig } from './config';
import { createExecutor } from './executor';
import { labKeys } from './lab';
import { createLog } from './log';
import { checkEngineKeys, currentMandate, type MandateRow, seedDeployment } from './mandates';
import type { CardanoPort, LabRunner, ReadInvoice, Settle, Verify } from './ports';
import { relayTrigger } from './relay';

/** Fiat currency CRE compares the invoice against, per mandate asset (the engine applies the same mapping). */
const FIAT: Record<string, string> = { USDM: 'usd' };

const cfg = loadConfig(process.env);
const db = pgDb(cfg.databaseUrl);
await migrate(db);
const now = () => Date.now();
const log = createLog(db, now);
const cardano: CardanoPort = createCardanoPort(process.env);

const sepoliaClient = createPublicClient({ chain: sepolia, transport: http(cfg.sepoliaRpcUrl) });
const trigger = cfg.cre.mode === 'relay' ? relayTrigger(db) : simulateBroadcast(cfg.cre);
const verify: Verify = async (action, triggerId) => {
  const currency = FIAT[action.amount.asset];
  if (!currency) return { status: 'unavailable', error: `no fiat currency for ${action.amount.asset}` };
  const request = { ...verificationRequestFor(action, cfg.stripeCustomerId), requested_currency: currency };
  return verifyInvoice(request, { trigger, client: sepoliaClient, registry: cfg.registry, newTriggerId: () => triggerId });
};

const reader = readOnlyStripe(cfg.stripeReadKey);
const readInvoice: ReadInvoice = (invoiceId) => getInvoice(reader, invoiceId);
if (!cfg.stripeSettlementKey.startsWith('rk_test_')) throw new Error('STRIPE_SETTLEMENT_KEY must be a test-mode restricted key (Invoices: Write)');
const settlementStripe = new Stripe(cfg.stripeSettlementKey, { maxNetworkRetries: 2 });
const settle: Settle = async (invoiceId, txHash) => {
  await markPaidOutOfBand(settlementStripe, invoiceId, txHash);
};

const executor = createExecutor({ db, log, now, cardano, settle });
const eng: Engine = {
  db,
  log,
  now,
  cardano,
  verify,
  readInvoice,
  engineKeys: cfg.engineKeys,
  enqueue: (id) => executor.enqueue(id),
  interpret: null,
  publicApiUrl: cfg.publicApiUrl,
};

// The public deployment record (committed) seeds the mandates; inserts are idempotent.
if (cfg.deploymentFile) {
  for (const line of await seedDeployment(db, JSON.parse(readFileSync(resolve(cfg.deploymentFile), 'utf8')))) console.log(`mandate ${line}`);
}
const rows = (await Promise.all(['M-001', 'M-LAB'].map((id) => currentMandate(db, id)))).filter((r): r is MandateRow => r !== null);
if (rows.length === 0) throw new Error('no mandates stored: run pnpm --filter @authority/api seed <deployment.json>');
checkEngineKeys(rows, cfg.engineKeys);

const runner: LabRunner | null = createLabRunner(process.env, cardano);
const lab = {
  runner,
  keys: labKeys(process.env),
  invoice: async (number: string) => {
    const open = await listOpenInvoices(reader, cfg.stripeCustomerId);
    const found = open.find((i) => i.number === number && i.payout_address !== null);
    return found ? { id: found.id, amount_usdm: found.amount_usdm, payout_address: found.payout_address as string } : null;
  },
};

await executor.resume();
createServer(createApp({ eng, lab, keys: cfg.keys, webOrigins: cfg.webOrigins })).listen(cfg.port, '0.0.0.0', () => {
  console.log(`authority api on :${cfg.port}, cre ${cfg.cre.mode}, mandates ${rows.map((r) => `${r.mandate.id}@${r.mandate.version}`).join(', ')}`);
});
