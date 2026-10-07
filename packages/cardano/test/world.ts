// An offline preprod-shaped world: real scripts from plutus.json, synthetic UTxOs, local Plutus evaluation.
import { bytesToHex, canonicalHash, publicKeyFromSecret } from '@authority/core';
import {
  DEFAULT_PROTOCOL_PARAMETERS,
  OfflineFetcher,
  type UTxO,
  core,
  pubKeyAddress,
  resolveScriptRef,
  serializeAddressObj,
  serializeData,
} from '@meshsdk/core';
import { MANDATE_TOKEN, VAULT_TOKEN, anchorScript, vaultScript } from '../src/blueprint';
import type { TxEnv } from '../src/chain';
import { type AnchorDatum, type PlutusJson, type VaultDatum, ZERO_VAULT_DATUM, anchorDatumData, vaultDatumData } from '../src/data';
import { type Deployment, PREPROD_USDM, anchorDatumFor } from '../src/deployment';
import type { LabContext } from '../src/lab';
import type { AnchorState, VaultState } from '../src/state';

export const NOW = Date.parse('2026-10-07T03:00:00.000Z');
export const USDM = PREPROD_USDM.policy + PREPROD_USDM.name;
export const ENGINE_SK = new Uint8Array(32).fill(7);
export const ATTACKER_SK = new Uint8Array(32).fill(9);
/** Test-seed keys only: the admin (principal) and the payment approver are different keys. */
export const PRINCIPAL_PKH = '5e'.repeat(28);
export const APPROVER_PKH = '5f'.repeat(28);
export const EXECUTOR = serializeAddressObj(pubKeyAddress('e0'.repeat(28)), 0);
export const PRINCIPAL = serializeAddressObj(pubKeyAddress(PRINCIPAL_PKH), 0);
export const AWS = serializeAddressObj(pubKeyAddress('a1'.repeat(28), 'a2'.repeat(28)), 0);
const H = (b: string) => b.repeat(32);
let serial = 0;
/** A tx hash never used before in this process. */
export const freshHash = () => (serial++).toString(16).padStart(64, 'f');

export const ada = (n: number) => ({ unit: 'lovelace', quantity: String(n * 1_000_000) });
export const usdm = (units: bigint) => ({ unit: USDM, quantity: units.toString() });
export const datumCbor = (d: PlutusJson) => serializeData(d, 'JSON');

export function labMandate(principalPkh: string, approverPkh: string, engineSk: Uint8Array, id = 'M-LAB') {
  return {
    schema: 'mandate/v0.1' as const,
    id,
    version: 1,
    status: 'active' as const,
    principal: { type: 'organization' as const, id: 'acme', name: 'Acme Corp', cardano_key_hash: principalPkh },
    delegate: { type: 'agent' as const, id: 'lab-agent-01', public_key: `ed25519:${'d0'.repeat(32)}` },
    approvers: [{ role: 'CFO', cardano_key_hash: approverPkh }],
    authority_engine: { public_key: `ed25519:${bytesToHex(publicKeyFromSecret(engineSk))}` },
    asset: { symbol: 'USDM', decimals: 6 },
    validity: { starts_at: '2026-10-07T00:00:00Z', expires_at: '2027-03-31T00:00:00Z' },
    delegation: { allowed: false as const },
    constraints: [
      { id: 'purpose', kind: 'purpose_in' as const, values: ['invoice_payment'], on_violation: 'DENY' as const },
      { id: 'action', kind: 'action_in' as const, values: ['pay_invoice'], on_violation: 'DENY' as const },
      { id: 'asset', kind: 'asset_eq' as const, value: 'USDM', on_violation: 'DENY' as const },
      { id: 'counterparty', kind: 'counterparty_in' as const, values: ['aws'], on_violation: 'REQUIRE_APPROVAL' as const, approver: 'CFO' },
      { id: 'autonomous', kind: 'amount_lte' as const, value: '1000000', on_violation: 'REQUIRE_APPROVAL' as const, approver: 'CFO' },
      { id: 'hard_cap', kind: 'amount_lte' as const, value: '5000000', on_violation: 'DENY' as const },
      { id: 'daily_cap', kind: 'daily_spend_lte' as const, value: '5000000', on_violation: 'DENY' as const },
      { id: 'treasury_floor', kind: 'balance_after_gte' as const, value: '1000000', on_violation: 'DENY' as const },
      { id: 'invoice_facts', kind: 'verified_facts' as const, source: 'stripe' as const, on_violation: 'DENY' as const },
    ],
  };
}

export interface World {
  env: TxEnv;
  /** Resolves every UTxO of this world, like Blockfrost would. */
  fetcher: OfflineFetcher;
  deployment: Deployment;
  /** Current anchor and vault UTxOs; `setAnchor` / `setVault` replace them with fresh UTxOs. */
  anchor: AnchorState;
  vault: VaultState;
  refScript: UTxO;
  executor: { address: string; utxos: UTxO[] };
  principal: { address: string; utxos: UTxO[] };
  /** Makes UTxOs resolvable by the evaluator (fakes an attacker created). */
  add(...utxos: UTxO[]): void;
  setAnchor(datum: AnchorDatum): AnchorState;
  setVault(datum: VaultDatum, balance: bigint): VaultState;
  lab(overrides?: Partial<LabContext>): LabContext;
}

/** `tag` keeps two worlds (M-LAB, M-001) apart: different seeds, so different scripts. */
export function world(tag = 'a', id = 'M-LAB'): World {
  const anchorSeed = { txHash: H(`${tag}5`), outputIndex: 0 };
  const vaultSeed = { txHash: H(`${tag}6`), outputIndex: 1 };
  const anchor = anchorScript(anchorSeed);
  const vault = vaultScript(anchor.hash, 0, vaultSeed);
  const refScript: UTxO = {
    input: { txHash: H(`${tag}3`), outputIndex: 0 },
    output: { address: EXECUTOR, amount: [ada(30)], scriptRef: resolveScriptRef({ code: vault.cbor, version: 'V3' }) },
  };
  const mandate = labMandate(PRINCIPAL_PKH, APPROVER_PKH, ENGINE_SK, id);
  const fetcher = new OfflineFetcher('preprod');
  const w: World = {
    env: { params: DEFAULT_PROTOCOL_PARAMETERS, evaluator: new core.OfflineEvaluatorScalus(fetcher, 'preprod') },
    fetcher,
    deployment: {
      mandate_id: id,
      mandate,
      chain_tag: 0,
      asset: PREPROD_USDM,
      anchor: { seed: anchorSeed, policy: anchor.hash, address: anchor.address, mint_tx: H(`${tag}1`) },
      vault: { seed: vaultSeed, hash: vault.hash, address: vault.address, mint_tx: H(`${tag}2`), ref_script: { ...refScript.input, address: EXECUTOR } },
    },
    anchor: null as never,
    vault: null as never,
    refScript,
    executor: {
      address: EXECUTOR,
      utxos: [
        { input: { txHash: H(`${tag}4`), outputIndex: 0 }, output: { address: EXECUTOR, amount: [ada(100)] } },
        { input: { txHash: H(`${tag}4`), outputIndex: 1 }, output: { address: EXECUTOR, amount: [ada(20)] } },
        refScript,
      ],
    },
    principal: {
      address: PRINCIPAL,
      utxos: [
        { input: anchorSeed, output: { address: PRINCIPAL, amount: [ada(20)] } },
        { input: vaultSeed, output: { address: PRINCIPAL, amount: [ada(50), usdm(30_000_000n)] } },
        { input: { txHash: H(`${tag}7`), outputIndex: 0 }, output: { address: PRINCIPAL, amount: [ada(40)] } },
      ],
    },
    add: (...utxos) => fetcher.addUTxOs(utxos),
    setAnchor: (datum) => {
      const utxo: UTxO = {
        input: { txHash: freshHash(), outputIndex: 0 },
        output: { address: anchor.address, amount: [ada(2), { unit: anchor.hash + MANDATE_TOKEN, quantity: '1' }], plutusData: datumCbor(anchorDatumData(datum)) },
      };
      w.add(utxo);
      w.anchor = { utxo, datum };
      return w.anchor;
    },
    setVault: (datum, balance) => {
      const utxo: UTxO = {
        input: { txHash: freshHash(), outputIndex: 0 },
        output: { address: vault.address, amount: [ada(5), { unit: vault.hash + VAULT_TOKEN, quantity: '1' }, usdm(balance)], plutusData: datumCbor(vaultDatumData(datum)) },
      };
      w.add(utxo);
      w.vault = { utxo, datum, balance };
      return w.vault;
    },
    lab: (overrides = {}) => ({
      deployment: w.deployment,
      anchor: w.anchor,
      vault: w.vault,
      refScript,
      executor: w.executor,
      engineSecretKey: ENGINE_SK,
      payee: AWS,
      actionHash: canonicalHash({ lab: 'action' }),
      nowMs: NOW,
      ...overrides,
    }),
  };
  w.add(...w.executor.utxos, ...w.principal.utxos);
  w.setAnchor(anchorDatumFor(mandate, PREPROD_USDM));
  w.setVault(ZERO_VAULT_DATUM, 10_000_000n);
  return w;
}
