// Runs every vault and anchor attack against the M-LAB mandate on preprod, plus the honest releases they need.
// Usage: pnpm --filter @authority/scripts cardano:lab
// Reads only M_LAB_* keys, the fee wallet and Blockfrost; never an M-001 key.
import { awaitIndexed,
  type Chain,
  FIXED_BUDGET,
  PREPROD_USDM,
  type SigningWallet,
  type TxPlan,
  anchorDatumFor,
  buildTx,
  connect,
  deployment,
  evaluateTx,
  keysOf,
  mandateAt,
  planAnchorRevoke,
  planAnchorUpdate,
  planDeposit,
  planRelease,
  planVaultReset,
  planWithdraw,
  readAnchor,
  readRefScript,
  readVault,
  scriptsOf,
  signAndSubmit,
  submitRaw,
  walletFromMnemonic,
} from '@authority/cardano';
import { ATTACKS, type Attack, type LabContext, labRecord, labRelease, planFakeVaultUtxo, planForgedAnchor, rejectedBy } from '@authority/cardano/lab';
import { type AuthorizationRecord, bytesToHex, canonicalHash, hexToBytes, publicKeyFromSecret, randomSecretKey } from '@authority/core';
import type { UTxO } from '@meshsdk/core';

process.loadEnvFile(new URL('../.env', import.meta.url));

const lab = deployment('M-LAB');
// Public deployment record only: its vault is a target, its keys are never read. Absent until M-001 is deployed.
const m001 = (() => { try { return deployment('M-001'); } catch { return null; } })();
scriptsOf(lab);
const engineHex = process.env.M_LAB_ENGINE_SECRET_KEY ?? '';
if (!/^[0-9a-f]{64}$/.test(engineHex)) throw new Error('M_LAB_ENGINE_SECRET_KEY must be 32 bytes of lowercase hex');
const engineSecretKey = hexToBytes(engineHex);
const payee = process.env.DEMO_VENDOR_AWS_ADDRESS ?? '';
if (!payee.startsWith('addr_test1')) throw new Error('DEMO_VENDOR_AWS_ADDRESS must be a preprod address');

const msToMidnight = 86_400_000 - (Date.now() % 86_400_000);
if (msToMidnight < 45 * 60_000) throw new Error('the daily-cap steps need one UTC day: start more than 45 minutes before 00:00 UTC');

const chain: Chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
const executor = await walletFromMnemonic(chain, process.env.FEE_WALLET_MNEMONIC, 'FEE_WALLET_MNEMONIC');
const principal = await walletFromMnemonic(chain, process.env.M_LAB_PRINCIPAL_MNEMONIC, 'M_LAB_PRINCIPAL_MNEMONIC');
const approver = await walletFromMnemonic(chain, process.env.M_LAB_APPROVER_MNEMONIC, 'M_LAB_APPROVER_MNEMONIC');
const keys = keysOf(lab);
if (principal.pkh !== keys.principal) throw new Error('M_LAB_PRINCIPAL_MNEMONIC is not the M-LAB admin key on record');
if (approver.pkh !== keys.approver) throw new Error('M_LAB_APPROVER_MNEMONIC is not the M-LAB approver key on record');

const actionHash = canonicalHash({ attack_lab: 'M-LAB', at: new Date().toISOString() });
const ref = (u: UTxO) => `${u.input.txHash}#${u.input.outputIndex}`;
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

async function context(): Promise<LabContext> {
  const [anchor, vault, refScript, wallet] = await Promise.all([readAnchor(chain.provider, lab), readVault(chain.provider, lab), readRefScript(chain.provider, lab), executor.snapshot()]);
  return { deployment: lab, anchor, vault, refScript, executor: wallet, engineSecretKey, payee, actionHash, nowMs: Date.now() };
}

async function targets(): Promise<string[]> {
  const [a, v] = await Promise.all([readAnchor(chain.provider, lab), readVault(chain.provider, lab)]);
  const w = m001 ? await readVault(chain.provider, m001) : null;
  return [ref(a.utxo), ref(v.utxo), ...(w ? [ref(w.utxo)] : [])];
}

/** A real, settled transaction. */
async function settle(step: string, plan: TxPlan, signers: SigningWallet[]): Promise<string> {
  const unsigned = await buildTx(chain, plan);
  const local = await evaluateTx(chain, unsigned);
  const hash = await signAndSubmit(chain, unsigned, signers);
  // The next context() must see this tx's outputs, or an attack is built on a spent UTxO and fails in phase 1 instead of in the script.
  // Explicit outputs plus every signer's change address: the next snapshot must not respend what this tx consumed.
  for (const address of new Set([...plan.outputs.map((o) => o.address), ...signers.map((s) => s.address)])) await awaitIndexed(chain, address, hash);
  console.log(json({ step, settled: hash, exec_units: local.ok ? local.budgets : local }));
  return hash;
}

const COSIGNER = { principal, approver } as const;

/** A real attack: built without evaluation, signed, evaluated locally for the trace, submitted, refused. */
async function attack(step: string, a: Attack): Promise<void> {
  const before = await targets();
  let tx = await buildTx(chain, a.plan, FIXED_BUDGET);
  for (const s of a.cosigner ? [executor, COSIGNER[a.cosigner]] : [executor]) tx = await s.sign(tx);
  const local = await evaluateTx(chain, tx);
  const node = await submitRaw(chain, tx);
  const after = await targets();
  const row = {
    step,
    expected: a.trace,
    local_trace: local.ok ? 'ACCEPTED' : [...local.logs, local.message.split('\n')[0]],
    node_status: node.status,
    node_phase2: node.body.includes('ValidationTagMismatch'),
    node_body: node.body.slice(0, 1500),
    funds_moved: after.join() === before.join() ? 0 : 'CHANGED',
  };
  console.log(json(row));
  if (!rejectedBy(local, a.trace) || node.ok || !row.node_phase2 || row.funds_moved !== 0) throw new Error(`${step}: not rejected as expected`);
}

const release = (c: LabContext, r: AuthorizationRecord) => planRelease(labRelease(c, r));
const usdm = (n: number) => String(Math.round(n * 1_000_000));

// 0. Start from 10.00 USDM and a fresh daily window (principal reset; last_nonce kept so old records stay dead).
let c = await context();
if (c.vault.balance !== 10_000_000n || c.vault.datum.spent_today !== 0n || c.vault.datum.day_index !== 0n) {
  await settle('reset vault to 10.00', planVaultReset(lab, c.anchor, c.vault, c.refScript, await principal.snapshot(), 10_000_000n), [principal]);
  c = await context();
}

// 1. Compromised-engine, executor and wrong-key attacks that need no prior state.
await attack('R10 hard cap 6.00', ATTACKS.hard_cap(c));
await attack('R9 wrong asset', ATTACKS.wrong_asset(c));
if (m001) {
  await attack('R5 authorization for the M-001 vault', ATTACKS.cross_vault(c, m001.vault.hash));
  const [m001Anchor, m001Vault, m001Ref] = await Promise.all([readAnchor(chain.provider, m001), readVault(chain.provider, m001), readRefScript(chain.provider, m001)]);
  await attack('R4 M-LAB authorization against the M-001 vault', ATTACKS.cross_mandate(c, { deployment: m001, anchor: m001Anchor, vault: m001Vault, refScript: m001Ref }));
} else {
  console.log('R4/R5 cross-vault attacks skipped: M-001 is not deployed yet');
}
await attack('R11 CFO bypass 1.80', ATTACKS.cfo_bypass(c));
await attack('R11 flagged 1.80 co-signed by the admin key instead of the approver', ATTACKS.principal_cosign(c));
await attack('W1 withdraw without the principal', ATTACKS.withdraw_without_principal(c));
await attack('W1 withdraw signed by the approver key alone', ATTACKS.approver_withdraw(c));
await attack('U1 update without the principal', ATTACKS.unauthorized_update(c));
await attack('U1 update signed by the approver key alone', ATTACKS.approver_update(c));
await attack('Revoke signed by the approver key alone', ATTACKS.approver_revoke(c));
await attack('M1 second MANDATE mint', ATTACKS.second_anchor_mint(c));
await attack('V1 second VAULT mint', ATTACKS.second_vault_mint(c));

// 2. The real release, then everything that tampers with a valid authorization.
const first = labRecord(c);
await settle('release 0.50 to AWS (demo vendor)', release(c, first), [executor]);
c = await context();
await attack('R8 replay of the settled authorization', ATTACKS.replay(c, first));
await attack('R16 recipient swap', ATTACKS.recipient_swap(c));
await attack('R6 amount swap 0.50 -> 5.00', ATTACKS.amount_swap(c));
await attack('R7 expired authorization', ATTACKS.expired(c));
await attack('R13 continuing datum reset', ATTACKS.datum_reset(c));
await attack('R14 skim 1 ADA from the vault', ATTACKS.skim(c));

// 3. Above the autonomous limit with the payment approver's co-signature (the R11 happy path).
await settle('release 1.80 co-signed by the approver', release(c, labRecord(c, { amount: usdm(1.8), requires_principal: true })), [executor, approver]);

// 4. A lower nonce dies once a higher one settles.
c = await context();
const lower = labRecord(c);
const higher = labRecord(c, { amount: usdm(0.9), nonce: (c.vault.datum.last_nonce + 2n).toString() });
await settle('release 0.90 with the higher nonce', release(c, higher), [executor]);
c = await context();
await attack('R8 stale lower nonce', ATTACKS.replay(c, lower));

// 5. Daily cap: 0.90 until the next one would exceed 5.00 today, then one more.
for (c = await context(); c.vault.datum.spent_today + 900_000n <= c.anchor.datum.daily_cap; c = await context()) {
  await settle(`release 0.90 (spent today ${c.vault.datum.spent_today})`, release(c, labRecord(c, { amount: usdm(0.9) })), [executor]);
}
await attack('R12 daily cap', ATTACKS.daily_cap(c));

// 6. Anyone may deposit.
await settle('deposit 0.50', planDeposit(lab, c.anchor, c.vault, c.refScript, 500_000n, await principal.snapshot()), [principal]);

// 7. Fake vault UTxO: R0, R1, then the principal recovers it (W1 happy path).
c = await context();
const fakeTx = await settle('fixture: attacker pays a UTxO to the vault address', planFakeVaultUtxo(c, await principal.snapshot()), [principal]);
const fake = (await chain.provider.fetchAddressUTxOs(lab.vault.address)).find((u) => u.input.txHash === fakeTx);
if (!fake) throw new Error('fake vault UTxO not found');
await attack('R0 release from a UTxO without the VAULT token', ATTACKS.fake_vault_utxo(c, fake));
await attack('R1 second vault input', ATTACKS.second_vault_input(c, fake));
await settle('principal recovers the fake UTxO', planWithdraw(lab, c.anchor, [fake], c.refScript, await principal.snapshot(), null), [principal]);

// 8. Forged anchor datum with the attacker's own engine key.
const attackerSk = randomSecretKey();
const forgedTx = await settle('fixture: attacker pays a forged anchor datum to the anchor address', planForgedAnchor(c, bytesToHex(publicKeyFromSecret(attackerSk)), c.executor), [executor]);
const forged = (await chain.provider.fetchAddressUTxOs(lab.anchor.address)).find((u) => u.input.txHash === forgedTx);
if (!forged) throw new Error('forged anchor UTxO not found');
c = await context();
await attack('R2 forged anchor without the MANDATE NFT', ATTACKS.fake_anchor(c, forged, attackerSk));

// 9. Treasury floor: the principal draws the vault down to 1.50; a 1.00 release would leave 0.50 < 1.00.
await settle('principal resets the vault to 1.50', planVaultReset(lab, c.anchor, c.vault, c.refScript, await principal.snapshot(), 1_500_000n), [principal]);
c = await context();
await attack('R15 treasury floor', ATTACKS.floor(c));

// 10. Version bump, then revoke: old authorizations die (R4, R3); then reactivate.
const beforeUpdate = labRecord(c);
await settle('principal updates the anchor to the next version', planAnchorUpdate(lab, c.anchor, anchorDatumFor(mandateAt(lab, c.anchor.datum.version + 1), PREPROD_USDM), await principal.snapshot()), [principal]);
c = await context();
await attack('R4 authorization from the previous version', ATTACKS.old_version(c, beforeUpdate));
const beforeRevoke = labRecord(c);
await settle('principal revokes the anchor', planAnchorRevoke(lab, c.anchor, await principal.snapshot()), [principal]);
c = await context();
await attack('R3 authorization under a revoked anchor', ATTACKS.revoked(c, beforeRevoke));
await settle('principal reactivates with a higher version', planAnchorUpdate(lab, c.anchor, anchorDatumFor(mandateAt(lab, c.anchor.datum.version + 1), PREPROD_USDM), await principal.snapshot()), [principal]);

// 11. Leave M-LAB ready for the Attack Lab: 10.00 USDM, fresh window, last_nonce kept.
c = await context();
await settle('reset vault to 10.00', planVaultReset(lab, c.anchor, c.vault, c.refScript, await principal.snapshot(), 10_000_000n), [principal]);
c = await context();
console.log(json({ done: true, mandate: `M-LAB@${c.anchor.datum.version}`, vault: ref(c.vault.utxo), usdm: c.vault.balance, datum: c.vault.datum }));
