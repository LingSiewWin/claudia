// Cardano preprod operations for the two mandates.
// Usage: pnpm --filter @authority/scripts cardano <keys | connect | fund | deploy <M-001|M-LAB> | status <M-001|M-LAB>>
// M-001 admin transactions are signed by the human in Lace (CIP-30) on a local page; M-LAB is signed here.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { awaitIndexed,
  type AnchorDatum,
  type Chain,
  type Deployment,
  PREPROD_USDM,
  PUBLIC_TEST_ENGINE_VKEY,
  type TxPlan,
  type Wallet,
  anchorDatumFor,
  awaitTx,
  buildTx,
  chainBinding,
  connect,
  engineState,
  keysOf,
  loadDeployments,
  mandateAt,
  mergeWitness,
  newMnemonic,
  planAnchorMint,
  planPayment,
  planRefScript,
  planVaultMint,
  quantityOf,
  readAnchor,
  readRefScript,
  readVault,
  saveDeployment,
  scriptsOf,
  signAndSubmit,
  submit,
  tipSlot,
  vkeyHashes,
  walletFromMnemonic,
  watchWallet,
} from '@authority/cardano';
import { type LaceSession, openLaceSession, planSummary } from '@authority/cardano/lace';
import { type Mandate, bytesToHex, hexToBytes, mandateHash, parseMandate, publicKeyFromSecret, randomSecretKey } from '@authority/core';
import { resolveTxHash } from '@meshsdk/core';

const ENV = new URL('../.env', import.meta.url);
process.loadEnvFile(ENV);

const USDM = PREPROD_USDM.policy + PREPROD_USDM.name;
const FUND: Record<string, bigint> = { 'M-001': 135_000_000n, 'M-LAB': 10_000_000n };
const MANIFESTS = new URL('../packages/cardano/deployments/manifests/', import.meta.url);

const [command, arg] = process.argv.slice(2);

function secretKey(name: string): Uint8Array {
  const hex = process.env[name];
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${name} must be 32 bytes of lowercase hex; run "keys" first`);
  return hexToBytes(hex);
}
const publicKey = (name: string) => bytesToHex(publicKeyFromSecret(secretKey(name)));

function mandateDocument(id: string, principalPkh: string, approverPkh: string): Mandate {
  const usdm = (n: number) => String(n * 1_000_000);
  const m001 = id === 'M-001';
  const limits = m001 ? { autonomous: 10, hard: 50, daily: 50, floor: 100 } : { autonomous: 1, hard: 5, daily: 5, floor: 1 };
  return parseMandate({
    schema: 'mandate/v0.1',
    id,
    version: m001 ? 3 : 1,
    status: 'active',
    principal: { type: 'organization', id: 'acme', name: 'Acme Corp', cardano_key_hash: principalPkh },
    delegate: { type: 'agent', id: m001 ? 'cfo-agent-01' : 'lab-agent-01', public_key: `ed25519:${publicKey(m001 ? 'M001_AGENT_SECRET_KEY' : 'M_LAB_AGENT_SECRET_KEY')}` },
    approvers: [{ role: 'CFO', cardano_key_hash: approverPkh }],
    authority_engine: { public_key: `ed25519:${publicKey(m001 ? 'M001_ENGINE_SECRET_KEY' : 'M_LAB_ENGINE_SECRET_KEY')}` },
    asset: { symbol: 'USDM', decimals: 6 },
    validity: { starts_at: '2026-10-07T00:00:00Z', expires_at: '2027-03-31T00:00:00Z' },
    delegation: { allowed: false },
    interrupt_budget: { per_day: 3 },
    constraints: [
      { id: 'purpose', kind: 'purpose_in', values: ['invoice_payment'], on_violation: 'DENY' },
      { id: 'action', kind: 'action_in', values: ['pay_invoice'], on_violation: 'DENY' },
      { id: 'asset', kind: 'asset_eq', value: 'USDM', on_violation: 'DENY' },
      { id: 'counterparty', kind: 'counterparty_in', values: m001 ? ['aws', 'stripe'] : ['aws'], on_violation: 'ESCALATE', approver: 'CFO' },
      { id: 'autonomous', kind: 'amount_lte', value: usdm(limits.autonomous), on_violation: 'ESCALATE', approver: 'CFO' },
      { id: 'hard_cap', kind: 'amount_lte', value: usdm(limits.hard), on_violation: 'DENY' },
      { id: 'daily_cap', kind: 'daily_spend_lte', value: usdm(limits.daily), on_violation: 'DENY' },
      { id: 'treasury_floor', kind: 'balance_after_gte', value: usdm(limits.floor), on_violation: 'DENY' },
      { id: 'invoice_facts', kind: 'verified_facts', source: 'stripe', on_violation: 'DENY' },
    ],
  });
}

/** Whoever holds a mandate's admin key: the human in Lace (M-001) or a CLI test key (M-LAB). */
interface Admin {
  address: string;
  pkh: string;
  snapshot(): Promise<Wallet>;
  /** Returns the tx with the admin's vkey witness added (and checked). */
  sign(step: string, txHex: string, plan: TxPlan): Promise<string>;
}

/** The CFO_HUMAN admin: the CLI only knows its public address; every signature comes from Lace. */
async function laceAdmin(chain: Chain, session: LaceSession): Promise<Admin> {
  const address = process.env.CFO_HUMAN_ADDRESS ?? '';
  if (!address.startsWith('addr_test1')) throw new Error('CFO_HUMAN_ADDRESS is missing; run "connect" first');
  console.log(`open ${session.url} in the browser where Lace runs (CFO admin wallet, network Preprod)`);
  const account = await session.connect();
  const w = watchWallet(chain, address);
  if (account.pkh !== w.pkh) throw new Error('the Lace wallet that connected is not CFO_HUMAN_ADDRESS; switch Lace to the CFO admin wallet');
  return {
    ...w,
    sign: async (step, txHex, plan) =>
      mergeWitness(txHex, await session.sign({ label: step, txHex, txHash: resolveTxHash(txHex), signer: w.pkh, summary: planSummary(plan) }), w.pkh),
  };
}

async function cliAdmin(chain: Chain, envName: string): Promise<Admin> {
  const w = await walletFromMnemonic(chain, process.env[envName], envName);
  return {
    ...w,
    sign: async (_step, txHex) => {
      const signed = await w.sign(txHex);
      if (!vkeyHashes(signed).includes(w.pkh)) throw new Error(`${envName} did not sign`);
      return signed;
    },
  };
}

async function approverPkh(chain: Chain, id: string): Promise<string> {
  const name = id === 'M-001' ? 'CFO_TEST_MNEMONIC' : 'M_LAB_APPROVER_MNEMONIC';
  return (await walletFromMnemonic(chain, process.env[name], name)).pkh;
}

interface ManifestStep {
  step: string;
  tx_hash: string;
  unsigned_tx: string;
  signer: string;
  expected: Record<string, string>;
  confirmed: boolean;
}

function writeManifest(id: string, header: Record<string, unknown>, steps: ManifestStep[]): void {
  mkdirSync(MANIFESTS, { recursive: true });
  writeFileSync(new URL(`${id}.json`, MANIFESTS), `${JSON.stringify({ mandate_id: id, network: 'preprod', ...header, steps }, null, 2)}\n`);
}

/** Build (evaluated), record in the manifest, sign, submit, wait for the block. */
async function run(chain: Chain, id: string, header: Record<string, unknown>, steps: ManifestStep[], step: string, plan: TxPlan, signer: Admin, expected: Record<string, string>): Promise<string> {
  const unsigned = await buildTx(chain, plan);
  const entry: ManifestStep = { step, tx_hash: resolveTxHash(unsigned), unsigned_tx: unsigned, signer: signer.pkh, expected, confirmed: false };
  steps.push(entry);
  writeManifest(id, header, steps);
  const hash = await submit(chain, await signer.sign(step, unsigned, plan));
  if (hash !== entry.tx_hash) throw new Error(`${step}: submitted ${hash}, built ${entry.tx_hash}`);
  await awaitTx(chain, hash);
  // The next step snapshots the signer's wallet: wait until its change output is indexed, or it would respend the inputs.
  await awaitIndexed(chain, signer.address, hash);
  entry.confirmed = true;
  writeManifest(id, header, steps);
  return hash;
}

const sameDatum = (a: AnchorDatum, b: AnchorDatum) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const lovelaceOf = (utxos: { output: { amount: { unit: string; quantity: string }[] } }[], unit = 'lovelace') =>
  utxos.reduce((n, u) => n + BigInt(u.output.amount.find((a) => a.unit === unit)?.quantity ?? '0'), 0n);

switch (command) {
  case 'keys': {
    const text = readFileSync(ENV, 'utf8');
    const make: Record<string, () => string> = {
      FEE_WALLET_MNEMONIC: () => `"${newMnemonic()}"`,
      CFO_TEST_MNEMONIC: () => `"${newMnemonic()}"`,
      M_LAB_PRINCIPAL_MNEMONIC: () => `"${newMnemonic()}"`,
      M_LAB_APPROVER_MNEMONIC: () => `"${newMnemonic()}"`,
      M001_ENGINE_SECRET_KEY: () => bytesToHex(randomSecretKey()),
      M001_AGENT_SECRET_KEY: () => bytesToHex(randomSecretKey()),
      M_LAB_ENGINE_SECRET_KEY: () => bytesToHex(randomSecretKey()),
      M_LAB_AGENT_SECRET_KEY: () => bytesToHex(randomSecretKey()),
    };
    let lead = text.endsWith('\n') || text === '' ? '' : '\n';
    for (const [name, value] of Object.entries(make)) {
      if (process.env[name]) {
        console.log(`${name}: present`);
        continue;
      }
      appendFileSync(ENV, `${lead}${name}=${value()}\n`);
      lead = '';
      console.log(`${name}: generated into .env`);
    }
    process.loadEnvFile(ENV);
    const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
    const pkhs: Record<string, string> = {};
    for (const [label, name] of [['fee wallet', 'FEE_WALLET_MNEMONIC'], ['M-001 approver (CFO_TEST)', 'CFO_TEST_MNEMONIC'], ['M-LAB principal', 'M_LAB_PRINCIPAL_MNEMONIC'], ['M-LAB approver', 'M_LAB_APPROVER_MNEMONIC']] as const) {
      const w = await walletFromMnemonic(chain, process.env[name], name);
      pkhs[label] = w.pkh;
      console.log(`${label.padEnd(26)} ${w.address} pkh ${w.pkh}`);
    }
    for (const n of ['M001_ENGINE_SECRET_KEY', 'M001_AGENT_SECRET_KEY', 'M_LAB_ENGINE_SECRET_KEY', 'M_LAB_AGENT_SECRET_KEY']) {
      const pk = publicKey(n);
      if (pk === PUBLIC_TEST_ENGINE_VKEY) throw new Error(`${n} is the public test key; delete that line and run "keys" again`);
      console.log(`${n.replace('SECRET_KEY', 'PUBLIC_KEY').padEnd(26)} ${pk}`);
    }
    const human = process.env.CFO_HUMAN_ADDRESS;
    if (human) pkhs['M-001 principal (CFO_HUMAN, Lace)'] = watchWallet(chain, human).pkh;
    if (new Set(Object.values(pkhs)).size !== Object.keys(pkhs).length) throw new Error(`two roles share one key: ${JSON.stringify(pkhs)}`);
    console.log(human ? `M-001 principal (CFO_HUMAN) ${human} pkh ${pkhs['M-001 principal (CFO_HUMAN, Lace)']}` : 'CFO_HUMAN_ADDRESS: missing (run "connect" with the CFO admin wallet open in Lace)');
    console.log('every role has its own key');
    break;
  }
  case 'connect': {
    const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
    const session = await openLaceSession();
    try {
      console.log(`open ${session.url} in the browser where Lace runs (CFO admin wallet, network Preprod)`);
      const account = await session.connect();
      const utxos = await watchWallet(chain, account.address).snapshot();
      console.log(`Lace CFO admin ${account.address} pkh ${account.pkh}: ${lovelaceOf(utxos.utxos)} lovelace, ${lovelaceOf(utxos.utxos, USDM)} tUSDM units`);
      if (process.env.CFO_TEST_MNEMONIC && (await approverPkh(chain, 'M-001')) === account.pkh) throw new Error('CFO_TEST_MNEMONIC is the Lace admin key; it must be a separate wallet');
      const known = process.env.CFO_HUMAN_ADDRESS;
      if (known && known !== account.address) throw new Error(`CFO_HUMAN_ADDRESS in .env is ${known}; Lace connected ${account.address}`);
      if (!known) {
        const text = readFileSync(ENV, 'utf8');
        appendFileSync(ENV, `${text.endsWith('\n') || text === '' ? '' : '\n'}CFO_HUMAN_ADDRESS=${account.address}\n`);
        console.log('CFO_HUMAN_ADDRESS: written into .env');
      } else console.log('CFO_HUMAN_ADDRESS: matches');
    } finally {
      await session.close();
    }
    break;
  }
  case 'fund': {
    const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
    const fee = await walletFromMnemonic(chain, process.env.FEE_WALLET_MNEMONIC, 'FEE_WALLET_MNEMONIC');
    const lab = await walletFromMnemonic(chain, process.env.M_LAB_PRINCIPAL_MNEMONIC, 'M_LAB_PRINCIPAL_MNEMONIC');
    const cfoTest = await walletFromMnemonic(chain, process.env.CFO_TEST_MNEMONIC, 'CFO_TEST_MNEMONIC');
    const [feeNow, labNow] = await Promise.all([fee.snapshot(), lab.snapshot()]);
    if (lovelaceOf(feeNow.utxos) >= 100_000_000n && lovelaceOf(labNow.utxos, USDM) >= 25_000_000n) {
      console.log('already funded');
      break;
    }
    const session = await openLaceSession();
    try {
      const cfo = await laceAdmin(chain, session);
      const plan = planPayment(
        [
          // Each paying wallet gets a small ADA-only UTxO that buildTx keeps as collateral.
          { address: fee.address, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
          { address: fee.address, amount: [{ unit: 'lovelace', quantity: '140000000' }] },
          { address: lab.address, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
          { address: lab.address, amount: [{ unit: 'lovelace', quantity: '30000000' }] },
          { address: lab.address, amount: [{ unit: 'lovelace', quantity: '5000000' }, { unit: USDM, quantity: '30000000' }] },
          // The M-001 approver only signs; 5 tADA makes the imported Lace wallet visibly the right one.
          { address: cfoTest.address, amount: [{ unit: 'lovelace', quantity: '5000000' }] },
        ],
        await cfo.snapshot(),
      );
      const unsigned = await buildTx(chain, plan);
      const hash = await submit(chain, await cfo.sign('fund the fee wallet, M-LAB principal and M-001 approver', unsigned, plan));
      await awaitTx(chain, hash);
      console.log(`fund tx ${hash}`);
    } finally {
      await session.close();
    }
    break;
  }
  case 'deploy': {
    const id = arg ?? '';
    if (id !== 'M-001' && id !== 'M-LAB') throw new Error(`unknown mandate ${id} (expected M-001 or M-LAB)`);
    if (loadDeployments()[id]) throw new Error(`${id} is already deployed (packages/cardano/deployments/preprod.json)`);
    const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
    const session = id === 'M-001' ? await openLaceSession() : null;
    try {
      const admin = session ? await laceAdmin(chain, session) : await cliAdmin(chain, 'M_LAB_PRINCIPAL_MNEMONIC');
      const executor = await walletFromMnemonic(chain, process.env.FEE_WALLET_MNEMONIC, 'FEE_WALLET_MNEMONIC');
      const mandate = mandateDocument(id, admin.pkh, await approverPkh(chain, id));
      const datum = anchorDatumFor(mandate, PREPROD_USDM);
      const header = { mandate_hash: mandateHash(mandate), principal_pkh: datum.principal_pkh, approver_pkh: datum.approver_pkh, engine_vkey: datum.engine_vkey };
      const steps: ManifestStep[] = [];

      let wallet = await admin.snapshot();
      // Seed: the largest ADA-only UTxO, so the smallest one stays free as collateral.
      const lovelace = (u: (typeof wallet.utxos)[number]) => BigInt(u.output.amount[0]?.quantity ?? '0');
      const anchorSeed = wallet.utxos.filter((u) => u.output.amount.length === 1 && !u.output.scriptRef).sort((a, b) => (lovelace(b) > lovelace(a) ? 1 : -1))[0];
      if (!anchorSeed) throw new Error(`${id} principal ${admin.address} has no ADA-only UTxO`);
      const anchor = planAnchorMint(anchorSeed, datum, wallet);
      const anchorTx = await run(chain, id, header, steps, 'anchor mint', anchor.plan, admin, { policy: anchor.script.hash, address: anchor.script.address });
      const anchorRecord = { seed: anchorSeed.input, policy: anchor.script.hash, address: anchor.script.address, mint_tx: anchorTx };
      // Found by policy + "MANDATE" at the script address: the minted policy is the one computed here.
      const anchorState = await readAnchor(chain.provider, { mandate_id: id, anchor: anchorRecord });
      if (!sameDatum(anchorState.datum, datum)) throw new Error(`${id}: the minted anchor datum differs from the one built`);
      console.log(`anchor mint ${anchorTx} policy ${anchor.script.hash}`);

      wallet = await admin.snapshot();
      const vaultSeed = wallet.utxos.find((u) => u.output.amount.some((a) => a.unit === USDM));
      if (!vaultSeed) throw new Error(`${id} principal holds no USDM to fund the vault`);
      const fund = FUND[id] ?? 0n;
      const vault = planVaultMint(PREPROD_USDM, anchorState, vaultSeed, fund, wallet);
      const vaultTx = await run(chain, id, header, steps, 'vault mint', vault.plan, admin, { vault_hash: vault.script.hash, address: vault.script.address, usdm: fund.toString() });
      console.log(`vault mint  ${vaultTx} hash ${vault.script.hash}`);

      const refPlan = planRefScript(vault.script, await executor.snapshot());
      const refTx = await signAndSubmit(chain, await buildTx(chain, refPlan), [executor]);
      const d: Deployment = {
        mandate_id: id,
        mandate,
        chain_tag: 0,
        asset: PREPROD_USDM,
        anchor: anchorRecord,
        vault: { seed: vaultSeed.input, hash: vault.script.hash, address: vault.script.address, mint_tx: vaultTx, ref_script: { txHash: refTx, outputIndex: 0, address: executor.address } },
      };
      scriptsOf(d);
      const [v, ref] = await Promise.all([readVault(chain.provider, d), readRefScript(chain.provider, d)]);
      if (v.balance !== fund || v.datum.last_nonce !== 0n || v.datum.day_index !== 0n || v.datum.spent_today !== 0n) throw new Error(`${id}: the vault UTxO is not the one built`);
      if (ref.output.scriptHash !== vault.script.hash) throw new Error(`${id}: the reference script is not the vault script`);
      saveDeployment(d);
      console.log(`ref script  ${refTx}#0 at ${executor.address}`);
      console.log(`saved ${id}: mandate_hash ${header.mandate_hash} version ${mandate.version} principal ${datum.principal_pkh} approver ${datum.approver_pkh}`);
    } finally {
      await session?.close();
    }
    break;
  }
  case 'status': {
    const d = loadDeployments()[arg ?? ''];
    if (!d) throw new Error(`no deployment for ${arg}`);
    const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
    scriptsOf(d);
    const [anchor, vault, slot] = await Promise.all([readAnchor(chain.provider, d), readVault(chain.provider, d), tipSlot(chain)]);
    const doc = mandateAt(d, anchor.datum.version);
    console.log(JSON.stringify(
      {
        mandate: `${d.mandate_id}@${anchor.datum.version}`,
        anchor: { utxo: `${anchor.utxo.input.txHash}#${anchor.utxo.input.outputIndex}`, status: anchor.datum.status, mandate_hash: anchor.datum.mandate_hash, document_hash_at_version: mandateHash(doc) },
        keys: { record: keysOf(d), on_chain: { principal: anchor.datum.principal_pkh, approver: anchor.datum.approver_pkh } },
        vault: { utxo: `${vault.utxo.input.txHash}#${vault.utxo.input.outputIndex}`, usdm: vault.balance.toString(), lovelace: quantityOf(vault.utxo, 'lovelace').toString() },
        engine_state: engineState(anchor, vault, slot),
        chain_binding: chainBinding(d),
      },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ));
    break;
  }
  default:
    throw new Error('usage: cardano <keys | connect | fund | deploy <M-001|M-LAB> | status <M-001|M-LAB>>');
}
