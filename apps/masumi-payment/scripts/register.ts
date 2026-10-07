// Masumi registration of the Human Authority Endpoint on the local payment service (admin key, setup only).
// Usage: pnpm --filter @authority/masumi-payment register <seed | info | register <apiBaseUrl> | status | key | update <apiBaseUrl>>
// Writes public values to ../registration.preprod.json, local ids to ../registration.local.json, and the scoped worker key into the repo-root .env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newMnemonic } from '@authority/cardano';

const REGISTRATION_FILE = fileURLToPath(new URL('../registration.preprod.json', import.meta.url));
const LOCAL_FILE = fileURLToPath(new URL('../registration.local.json', import.meta.url));
const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));
const MPS_RELEASE = '0.29.0 (71455701ac22c3380c50da54089e1b7363f6825d)';
const TEST_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
// The registry caps description at 250 characters (MPS 0.29.0 validation).
const LISTING =
  'Agents pay to interrupt a named human. Send the action your agent wants to take; get ALLOW, ESCALATE or DENY with a decision brief. ' +
  'On ESCALATE you get the exact bond price and endpoint to reach the human. Only the human signature moves funds.';

// Masumi's published Preprod Web3CardanoV2 defaults (payment-core config.ts at release 0.29.0). The service derives
// the escrow address from these; `seed` refuses a source whose address differs.
const PREPROD_V2 = {
  adminWallets: [
    'addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3',
    'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a',
    'addr_test1qzy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsq99mm6w',
  ],
  requiredAdminSignatures: 2,
  cooldownTimeMs: 7 * 60 * 1000,
  smartContractAddress: 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
  registryPolicyId: '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b',
};
const SELLING_ENV = 'MPS_SELLING_WALLET_PREPROD_MNEMONIC';
const PURCHASING_ENV = 'MPS_PURCHASING_WALLET_PREPROD_MNEMONIC';

const PUBLIC_KEYS = new Set([
  'network',
  'paymentSourceType',
  'mpsRelease',
  'smartContractAddress',
  'policyId',
  'sellerVkey',
  'sellerAddress',
  'state',
  'agentIdentifier',
  'supportedPaymentSourceIndex',
  'registrationTxHash',
]);

const base = (process.env.PAYMENT_SERVICE_URL ?? '').replace(/\/+$/, '');
const adminKey = process.env.MPS_ADMIN_KEY ?? '';
if (!base || !adminKey) throw new Error('PAYMENT_SERVICE_URL and MPS_ADMIN_KEY must be set in .env');

type Json = Record<string, any>;
const readJson = (path: string): Json => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Json) : {});
const load = (): Json => ({ ...readJson(LOCAL_FILE), ...readJson(REGISTRATION_FILE) });
const save = (r: Json): void => {
  const pub: Json = {};
  const local: Json = {};
  for (const [k, v] of Object.entries(r)) (PUBLIC_KEYS.has(k) ? pub : local)[k] = v;
  writeFileSync(REGISTRATION_FILE, `${JSON.stringify(pub, null, 2)}\n`);
  writeFileSync(LOCAL_FILE, `${JSON.stringify(local, null, 2)}\n`);
};

async function mps(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { token: adminKey, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as Json | null;
  if (!res.ok || json?.status !== 'success') throw new Error(`payment service ${method} ${path} HTTP ${res.status}: ${JSON.stringify(json?.error ?? json?.message ?? null)}`);
  return json.data as Json;
}

async function balances(address: string): Promise<{ lovelace: string; tusdm: string }> {
  const res = await fetch(`https://cardano-preprod.blockfrost.io/api/v0/addresses/${address}`, {
    headers: { project_id: process.env.BLOCKFROST_PROJECT_ID_PREPROD ?? '' },
  });
  if (res.status === 404) return { lovelace: '0', tusdm: '0' };
  if (!res.ok) throw new Error(`Blockfrost HTTP ${res.status}`);
  const amount = ((await res.json()) as { amount: { unit: string; quantity: string }[] }).amount;
  const of = (unit: string): string => amount.find((a) => a.unit === unit)?.quantity ?? '0';
  return { lovelace: of('lovelace'), tusdm: of(TEST_USDM_UNIT) };
}

// The hot wallet mnemonics live only in the local .env (and encrypted in the payment service). Reused on a re-run.
function walletMnemonic(name: string): string {
  const current = process.env[name]?.trim();
  if (current) return current;
  const env = readFileSync(ENV_FILE, 'utf8');
  const fromFile = env.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim();
  if (fromFile) return fromFile;
  const words = newMnemonic();
  writeFileSync(ENV_FILE, `${env.replace(/\n?$/, '\n')}${name}=${words}\n`);
  return words;
}

// Creates the Preprod Web3CardanoV2 payment source the guide's prisma seed would create (the Docker image cannot
// run that seed). Idempotent: an existing Preprod V2 source is kept.
async function seed(): Promise<void> {
  const { PaymentSources } = await mps('GET', '/payment-source?take=100');
  const existing = (PaymentSources as Json[]).find((s) => s.network === 'Preprod' && s.paymentSourceType === 'Web3CardanoV2');
  if (existing) return console.log(JSON.stringify({ seeded: false, smartContractAddress: existing.smartContractAddress, policyId: existing.policyId }));
  const blockfrost = process.env.BLOCKFROST_PROJECT_ID_PREPROD?.trim();
  if (!blockfrost) throw new Error('BLOCKFROST_PROJECT_ID_PREPROD must be set in .env');
  const created = await mps('POST', '/payment-source-extended', {
    network: 'Preprod',
    paymentSourceType: 'Web3CardanoV2',
    PaymentSourceConfig: { rpcProviderApiKey: blockfrost, rpcProvider: 'Blockfrost' },
    cooldownTime: PREPROD_V2.cooldownTimeMs,
    AdminWallets: PREPROD_V2.adminWallets.map((walletAddress) => ({ walletAddress })),
    requiredAdminSignatures: PREPROD_V2.requiredAdminSignatures,
    PurchasingWallets: [{ walletMnemonic: walletMnemonic(PURCHASING_ENV), collectionAddress: null, note: 'Human Authority Endpoint purchasing wallet' }],
    SellingWallets: [{ walletMnemonic: walletMnemonic(SELLING_ENV), collectionAddress: null, note: 'Human Authority Endpoint selling wallet' }],
  });
  const ok = created.smartContractAddress === PREPROD_V2.smartContractAddress && created.policyId === PREPROD_V2.registryPolicyId;
  if (!ok) {
    await mps('DELETE', `/payment-source-extended?id=${encodeURIComponent(String(created.id))}`).catch(() => undefined);
    throw new Error(`payment source derived ${String(created.smartContractAddress)} / ${String(created.policyId)}; expected Masumi's Preprod V2 escrow. Removed.`);
  }
  console.log(JSON.stringify({ seeded: true, smartContractAddress: created.smartContractAddress, policyId: created.policyId }));
}

async function info(): Promise<void> {
  const { PaymentSources } = await mps('GET', '/payment-source?take=100');
  const source = (PaymentSources as Json[]).find((s) => s.network === 'Preprod' && s.paymentSourceType === 'Web3CardanoV2');
  if (!source) throw new Error('no Preprod Web3CardanoV2 payment source; run the seed first');
  const { Wallets } = await mps('GET', `/wallet/list?walletType=Selling&paymentSourceId=${encodeURIComponent(source.id)}&take=10`);
  const wallets = Wallets as Json[];
  if (wallets.length !== 1 || !wallets[0]) throw new Error(`expected one selling wallet, found ${wallets.length}`);
  const w = wallets[0];
  if (w.collectionAddress !== null) throw new Error('the selling wallet has a collection address override; it must be null for default seller payout');
  save({
    ...load(),
    network: 'Preprod',
    paymentSourceType: 'Web3CardanoV2',
    mpsRelease: MPS_RELEASE,
    paymentSourceId: source.id,
    smartContractAddress: source.smartContractAddress,
    policyId: source.policyId,
    sellingWalletId: w.id,
    sellerVkey: w.walletVkey,
    sellerAddress: w.walletAddress,
  });
  console.log(JSON.stringify({ smartContractAddress: source.smartContractAddress, policyId: source.policyId, sellerAddress: w.walletAddress, sellerVkey: w.walletVkey, collectionAddress: w.collectionAddress, balance: await balances(w.walletAddress) }, null, 2));
}

// Registry metadata shared by register and update (public, on-chain).
const metadata = (apiBaseUrl: string): Json => ({
  network: 'Preprod',
  ExampleOutputs: [],
  Tags: ['human-authority', 'approvals', 'treasury', 'agents'],
  name: 'Human Authority Endpoint',
  description: LISTING,
  Capability: { name: 'human-authority', version: '0.2.0' },
  Author: { name: 'Authority Layer' },
  apiBaseUrl,
});

async function register(apiBaseUrl: string): Promise<void> {
  new URL(apiBaseUrl);
  const r = load();
  if (r.registrationId) return console.log(`already registered: ${r.registrationId}`);
  if (r.registrationPending) throw new Error('an earlier register call did not finish; check the dashboard before removing registrationPending');
  if (!r.sellerVkey) throw new Error('run info first');
  save({ ...r, registrationPending: true, apiBaseUrl });
  const created = await mps('POST', '/registry', {
    ...metadata(apiBaseUrl),
    sellingWalletVkey: r.sellerVkey,
    supportedPaymentSources: [
      { chain: 'Cardano', network: 'Preprod', paymentSourceType: 'Web3CardanoV2', address: r.smartContractAddress, pricing: { pricingType: 'Dynamic' } },
    ],
  });
  save({ ...load(), registrationPending: false, registrationId: created.id, state: created.state });
  console.log(JSON.stringify({ registrationId: created.id, state: created.state }));
}

async function status(): Promise<void> {
  const r = load();
  if (!r.registrationId) throw new Error('not registered yet');
  const { Assets } = await mps('GET', '/registry?network=Preprod&filterPaymentSourceType=Web3CardanoV2&limit=100');
  const a = (Assets as Json[]).find((x) => x.id === r.registrationId);
  if (!a) throw new Error(`registration ${r.registrationId} not found`);
  const index = ((a.supportedPaymentSources ?? []) as Json[]).findIndex(
    (s) => s.chain === 'Cardano' && s.paymentSourceType === 'Web3CardanoV2' && s.address === r.smartContractAddress,
  );
  save({ ...r, state: a.state, agentIdentifier: a.agentIdentifier ?? null, supportedPaymentSourceIndex: index, registrationTxHash: a.CurrentTransaction?.txHash ?? null });
  console.log(JSON.stringify({ state: a.state, agentIdentifier: a.agentIdentifier ?? null, supportedPaymentSourceIndex: index, tx: a.CurrentTransaction ?? null }, null, 2));
}

async function key(): Promise<void> {
  const r = load();
  if (r.runtimeKeyId) return console.log(`worker key already created: ${r.runtimeKeyId}`);
  if (!r.sellingWalletId) throw new Error('run info first');
  const env = readFileSync(ENV_FILE, 'utf8');
  if (!/^PAYMENT_API_KEY=$/m.test(env)) throw new Error('.env must contain an empty PAYMENT_API_KEY= line');
  const k = await mps('POST', '/api-key', {
    usageLimited: 'false',
    UsageCredits: [],
    NetworkLimit: ['Preprod'],
    canRead: true,
    canPay: true,
    canAdmin: false,
    walletScopeEnabled: true,
    WalletScopeHotWalletIds: [r.sellingWalletId],
  });
  save({ ...r, runtimeKeyId: k.id });
  if (typeof k.token !== 'string' || k.token.startsWith('*')) throw new Error(`key ${k.id} was created but its token was not returned`);
  writeFileSync(ENV_FILE, env.replace(/^PAYMENT_API_KEY=$/m, `PAYMENT_API_KEY=${k.token}`));
  console.log(JSON.stringify({ id: k.id, canRead: k.canRead, canPay: k.canPay, canAdmin: k.canAdmin, NetworkLimit: k.NetworkLimit, walletScopeEnabled: k.walletScopeEnabled, WalletScopeHotWalletIds: k.WalletScopeHotWalletIds }));
}

// Points the registration at a new agent API URL. The payment service bumps the agentIdentifier version;
// run status afterwards and restart the worker with the new registration file.
async function update(apiBaseUrl: string): Promise<void> {
  new URL(apiBaseUrl);
  const r = load();
  if (r.state !== 'RegistrationConfirmed' && r.state !== 'UpdateConfirmed') throw new Error(`registration is ${String(r.state)}; wait for confirmation`);
  const updated = await mps('POST', '/registry/update', {
    ...metadata(apiBaseUrl),
    agentIdentifier: r.agentIdentifier,
    smartContractAddress: r.smartContractAddress,
  });
  save({ ...r, registrationId: updated.id, state: updated.state, apiBaseUrl });
  console.log(JSON.stringify({ registrationId: updated.id, state: updated.state }));
}

const [command, arg] = process.argv.slice(2);
if (command === 'seed') await seed();
else if (command === 'info') await info();
else if (command === 'register' && arg) await register(arg);
else if (command === 'status') await status();
else if (command === 'key') await key();
else if (command === 'update' && arg) await update(arg);
else throw new Error('usage: register.ts <seed | info | register <apiBaseUrl> | status | key | update <apiBaseUrl>>');
