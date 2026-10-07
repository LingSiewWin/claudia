import { type AuthorizationRecord, bytesToHex, parseShelleyAddress } from '@authority/core';
import { deserializeDatum } from '@meshsdk/core';
import type { BondDatum } from './bond';

/** Plutus data in Mesh's "JSON" form (constructor index + fields, bytes as hex, ints). */
export type PlutusJson = { constructor: number; fields: PlutusJson[] } | { bytes: string } | { int: number | bigint };

/** On-chain field order (contracts/cardano/lib/authority/types.ak): the index of each field is part of the wire format. */
export interface AnchorDatum {
  mandate_hash: string;
  version: number;
  status: 'active' | 'revoked';
  engine_vkey: string;
  /** Admin key: anchor and vault mint, Update, Revoke, PrincipalWithdraw. */
  principal_pkh: string;
  /** Payment approver key: only the R11 co-signature of a flagged release. */
  approver_pkh: string;
  asset_policy: string;
  asset_name: string;
  autonomous_limit: bigint;
  hard_cap: bigint;
  daily_cap: bigint;
  treasury_minimum: bigint;
  valid_until: bigint;
}

export interface VaultDatum {
  last_nonce: bigint;
  day_index: bigint;
  spent_today: bigint;
}

export const ZERO_VAULT_DATUM: VaultDatum = { last_nonce: 0n, day_index: 0n, spent_today: 0n };

const con = (index: number, fields: PlutusJson[] = []): PlutusJson => ({ constructor: index, fields });
const bytes = (hex: string): PlutusJson => ({ bytes: hex });
const int = (n: number | bigint): PlutusJson => ({ int: n });

export function anchorDatumData(d: AnchorDatum): PlutusJson {
  return con(0, [
    bytes(d.mandate_hash),
    int(d.version),
    con(d.status === 'active' ? 0 : 1),
    bytes(d.engine_vkey),
    bytes(d.principal_pkh),
    bytes(d.approver_pkh),
    bytes(d.asset_policy),
    bytes(d.asset_name),
    int(d.autonomous_limit),
    int(d.hard_cap),
    int(d.daily_cap),
    int(d.treasury_minimum),
    int(d.valid_until),
  ]);
}

export const vaultDatumData = (d: VaultDatum): PlutusJson => con(0, [int(d.last_nonce), int(d.day_index), int(d.spent_today)]);

/** Spec 02 fields 2-20 as the vault's typed `Authorization` (recipient split into tags and hashes). */
export function authorizationData(r: AuthorizationRecord): PlutusJson {
  const f = r.fields;
  const to = parseShelleyAddress(f.recipient);
  return con(0, [
    int(f.chain_tag),
    bytes(f.vault_hash),
    bytes(f.mandate_ref),
    bytes(f.mandate_hash),
    int(f.mandate_version),
    bytes(f.action_hash),
    int(f.action_type),
    bytes(f.asset_policy),
    bytes(f.asset_name),
    int(BigInt(f.amount)),
    int(to.payment.tag === 'key' ? 0 : 1),
    bytes(bytesToHex(to.payment.hash)),
    int(to.stake === null ? 0 : to.stake.tag === 'key' ? 1 : 2),
    bytes(to.stake === null ? '' : bytesToHex(to.stake.hash)),
    int(BigInt(f.nonce)),
    int(f.valid_until),
    int(f.requires_principal ? 1 : 0),
    bytes(f.verification_ref ?? '00'.repeat(32)),
  ]);
}

export const releaseRedeemer = (r: AuthorizationRecord): PlutusJson => con(0, [authorizationData(r), bytes(r.signature_hex)]);
export const DEPOSIT: PlutusJson = con(1);
export const PRINCIPAL_WITHDRAW: PlutusJson = con(2);
export const anchorUpdate = (next: AnchorDatum): PlutusJson => con(0, [anchorDatumData(next)]);
export const ANCHOR_REVOKE: PlutusJson = con(1);
/** Both mint handlers ignore their redeemer. */
export const MINT_REDEEMER: PlutusJson = con(0);
/** R16: the recipient output carries the authorization digest as inline datum. */
export const digestDatum = (r: AuthorizationRecord): PlutusJson => bytes(r.digest_hex);

/** Escrow `BondDatum` (contracts/cardano/lib/authority/types.ak), `agent_stake` as Option. */
export function bondDatumData(d: BondDatum): PlutusJson {
  return con(0, [
    bytes(d.approval_ref),
    bytes(d.action_hash),
    bytes(d.mandate_ref),
    bytes(d.agent_pkh),
    d.agent_stake === null ? con(1) : con(0, [bytes(d.agent_stake)]),
    bytes(d.approver_pkh),
    int(d.amount),
    int(d.locked_until_ms),
  ]);
}
export const BOND_REFUND: PlutusJson = con(0);
export const BOND_CAPTURE: PlutusJson = con(1);

interface Raw {
  constructor?: unknown;
  fields?: Raw[];
  bytes?: unknown;
  int?: unknown;
}

function constr(raw: Raw, index: number, arity: number, label: string): Raw[] {
  const c = raw.constructor;
  if ((typeof c !== 'bigint' && typeof c !== 'number') || Number(c) !== index || raw.fields?.length !== arity) {
    throw new TypeError(`${label}: expected constructor ${index} with ${arity} fields`);
  }
  return raw.fields;
}

function hexOf(raw: Raw | undefined, label: string): string {
  if (typeof raw?.bytes !== 'string') throw new TypeError(`${label}: expected bytes`);
  return raw.bytes;
}

function intOf(raw: Raw | undefined, label: string): bigint {
  if (typeof raw?.int !== 'bigint' && typeof raw?.int !== 'number') throw new TypeError(`${label}: expected int`);
  return BigInt(raw.int);
}

export function parseAnchorDatum(cbor: string): AnchorDatum {
  const f = constr(deserializeDatum<Raw>(cbor), 0, 13, 'AnchorDatum');
  const status = f[2] ?? {};
  const revoked = Number(status.constructor) === 1;
  constr(status, revoked ? 1 : 0, 0, 'AnchorDatum.status');
  return {
    mandate_hash: hexOf(f[0], 'mandate_hash'),
    version: Number(intOf(f[1], 'version')),
    status: revoked ? 'revoked' : 'active',
    engine_vkey: hexOf(f[3], 'engine_vkey'),
    principal_pkh: hexOf(f[4], 'principal_pkh'),
    approver_pkh: hexOf(f[5], 'approver_pkh'),
    asset_policy: hexOf(f[6], 'asset_policy'),
    asset_name: hexOf(f[7], 'asset_name'),
    autonomous_limit: intOf(f[8], 'autonomous_limit'),
    hard_cap: intOf(f[9], 'hard_cap'),
    daily_cap: intOf(f[10], 'daily_cap'),
    treasury_minimum: intOf(f[11], 'treasury_minimum'),
    valid_until: intOf(f[12], 'valid_until'),
  };
}

export function parseVaultDatum(cbor: string): VaultDatum {
  const f = constr(deserializeDatum<Raw>(cbor), 0, 3, 'VaultDatum');
  return { last_nonce: intOf(f[0], 'last_nonce'), day_index: intOf(f[1], 'day_index'), spent_today: intOf(f[2], 'spent_today') };
}

export function parseBondDatum(cbor: string): BondDatum {
  const f = constr(deserializeDatum<Raw>(cbor), 0, 8, 'BondDatum');
  const stake = f[4] ?? {};
  const none = Number(stake.constructor) === 1;
  const stakeFields = constr(stake, none ? 1 : 0, none ? 0 : 1, 'BondDatum.agent_stake');
  return {
    approval_ref: hexOf(f[0], 'approval_ref'),
    action_hash: hexOf(f[1], 'action_hash'),
    mandate_ref: hexOf(f[2], 'mandate_ref'),
    agent_pkh: hexOf(f[3], 'agent_pkh'),
    agent_stake: none ? null : hexOf(stakeFields[0], 'agent_stake'),
    approver_pkh: hexOf(f[5], 'approver_pkh'),
    amount: intOf(f[6], 'amount'),
    locked_until_ms: Number(intOf(f[7], 'locked_until_ms')),
  };
}
