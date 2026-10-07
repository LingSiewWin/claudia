import { readFileSync, writeFileSync } from 'node:fs';
import { type ChainBinding, type Mandate, anchorProjection, bytesToHex, parseMandate, publicKeyFromSecret } from '@authority/core';
import { type OutRef, type Script, anchorScript, vaultScript } from './blueprint';
import type { AnchorDatum } from './data';

/** Settlement asset on preprod: the tUSDM the Masumi dispenser hands out (6 decimals). */
export const PREPROD_USDM = { policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde', name: '0014df10745553444d' };

/** Public key of the published test engine secret (32 x 0x01) used by the core vectors and Aiken fixtures. */
export const PUBLIC_TEST_ENGINE_VKEY = bytesToHex(publicKeyFromSecret(new Uint8Array(32).fill(1)));

export interface Deployment {
  mandate_id: string;
  /** The mandate document at the version the anchor was minted with. */
  mandate: Mandate;
  chain_tag: 0;
  asset: { policy: string; name: string };
  anchor: { seed: OutRef; policy: string; address: string; mint_tx: string };
  vault: { seed: OutRef; hash: string; address: string; mint_tx: string; ref_script: OutRef & { address: string } };
}

export type Deployments = Record<string, Deployment>;

const FILE = new URL('../deployments/preprod.json', import.meta.url);

export function loadDeployments(): Deployments {
  return JSON.parse(readFileSync(FILE, 'utf8')) as Deployments;
}

export function deployment(id: string): Deployment {
  const d = loadDeployments()[id];
  if (!d) throw new Error(`no preprod deployment for ${id}`);
  return d;
}

export function saveDeployment(d: Deployment): void {
  const all = loadDeployments();
  all[d.mandate_id] = d;
  writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`);
}

/** Re-applies the blueprint to the recorded seeds; any drift between plutus.json and the deployment throws. */
export function scriptsOf(d: Deployment): { anchor: Script; vault: Script } {
  const anchor = anchorScript(d.anchor.seed);
  const vault = vaultScript(anchor.hash, d.chain_tag, d.vault.seed);
  if (anchor.hash !== d.anchor.policy || vault.hash !== d.vault.hash || vault.address !== d.vault.address) {
    throw new Error(`${d.mandate_id}: plutus.json no longer matches the deployed scripts`);
  }
  return { anchor, vault };
}

/** The admin and payment-approver key hashes of a deployed mandate, read from its record. */
export const keysOf = (d: Deployment): { principal: string; approver: string } => {
  const p = anchorProjection(parseMandate(d.mandate));
  return { principal: p.principal_pkh, approver: p.approver_pkh };
};

/** The anchor datum for a mandate document (spec 03 section 2), bound to the settlement asset. */
export function anchorDatumFor(m: Mandate, asset: { policy: string; name: string }): AnchorDatum {
  const p = anchorProjection(parseMandate(m));
  return {
    mandate_hash: p.mandate_hash,
    version: p.version,
    status: p.status,
    engine_vkey: p.engine_vkey,
    principal_pkh: p.principal_pkh,
    approver_pkh: p.approver_pkh,
    asset_policy: asset.policy,
    asset_name: asset.name,
    autonomous_limit: p.autonomous_limit,
    hard_cap: p.hard_cap,
    daily_cap: p.daily_cap,
    treasury_minimum: p.treasury_minimum,
    valid_until: BigInt(p.valid_until_ms),
  };
}

/** Refuses an anchor datum that must never reach the chain. Every anchor mint and Update builder calls it. */
export function assertDeployable(d: AnchorDatum): void {
  if (d.engine_vkey === PUBLIC_TEST_ENGINE_VKEY) throw new Error('anchor engine key is the public test key');
  if (!/^[0-9a-f]{56}$/.test(d.principal_pkh) || !/^[0-9a-f]{56}$/.test(d.approver_pkh)) throw new Error('anchor key hashes must be 28 bytes');
  if (d.approver_pkh === d.principal_pkh) throw new Error('anchor approver key must differ from the principal admin key');
}

/** The document for a later anchor version. v0.1 Updates change only the version. */
export const mandateAt = (d: Deployment, version: number): Mandate => ({ ...d.mandate, version });

/** What the issuance gate (core `issueAuthorization`) binds an authorization to. */
export const chainBinding = (d: Deployment): ChainBinding => ({
  chainTag: d.chain_tag,
  vaultHash: d.vault.hash,
  mandateRef: d.anchor.policy,
  assetPolicy: d.asset.policy,
  assetName: d.asset.name,
  assetSymbol: d.mandate.asset.symbol,
});
