import { type Credential, parseShelleyAddress } from './address';
import { bytesToHex, concatBytes, hexOfLength, uintBE, utf8ToBytes } from './bytes';
import { publicKeyFromSecret, signBytes, verifyBytes } from './ed25519';
import { blake2b256 } from './hash';

export const AUTHORIZATION_DOMAIN = 'AGENT_AUTHORIZATION_V1';
export const ACTION_TYPE_CODE = { pay_invoice: 1 } as const;
const U64_LIMIT = 1n << 64n;

export interface AuthorizationFields {
  chainTag: 0 | 1;
  vaultHash: string;
  mandateRef: string;
  mandateHash: string;
  mandateVersion: number;
  actionHash: string;
  actionType: number;
  assetPolicy: string;
  assetName: string;
  amount: bigint;
  recipient: string;
  nonce: bigint;
  validUntil: bigint;
  requiresPrincipal: boolean;
  verificationRef: string | null;
}

export interface AuthorizationRecordFields {
  chain_tag: 0 | 1;
  vault_hash: string;
  mandate_ref: string;
  mandate_hash: string;
  mandate_version: number;
  action_hash: string;
  action_type: number;
  asset_policy: string;
  asset_name: string;
  amount: string;
  recipient: string;
  nonce: string;
  valid_until: number;
  requires_principal: boolean;
  verification_ref: string | null;
}

export interface AuthorizationRecord {
  schema: 'authorization/v0.1';
  message_hex: string;
  digest_hex: string;
  signature_hex: string;
  engine_public_key: string;
  fields: AuthorizationRecordFields;
}

function credential(c: Credential, keyTag: number, scriptTag: number): Uint8Array {
  return concatBytes(Uint8Array.of(c.tag === 'key' ? keyTag : scriptTag), c.hash);
}

function inRange(value: bigint, label: string): bigint {
  if (value <= 0n || value >= U64_LIMIT) throw new RangeError(`${label}: must be in 1..2^64-1`);
  return value;
}

export function encodeAuthorization(f: AuthorizationFields): Uint8Array {
  if (f.chainTag !== 0 && f.chainTag !== 1) throw new RangeError('chainTag: must be 0 or 1');
  if (!Number.isInteger(f.mandateVersion) || f.mandateVersion < 1 || f.mandateVersion > 0xffffffff) {
    throw new RangeError('mandateVersion: must be a u32 >= 1');
  }
  if (!Number.isInteger(f.actionType) || f.actionType < 1 || f.actionType > 0xff) {
    throw new RangeError('actionType: must be a u8 >= 1');
  }
  if (!/^(?:[0-9a-fA-F]{2}){0,32}$/.test(f.assetName)) throw new TypeError('assetName: 0..32 bytes of hex');
  const assetName = hexOfLength(f.assetName, f.assetName.length / 2, 'assetName');
  const recipient = parseShelleyAddress(f.recipient);
  if (recipient.network !== f.chainTag) throw new TypeError('recipient: network does not match chainTag');
  const stake = recipient.stake ? credential(recipient.stake, 1, 2) : Uint8Array.of(0);
  return concatBytes(
    utf8ToBytes(AUTHORIZATION_DOMAIN),
    Uint8Array.of(f.chainTag),
    hexOfLength(f.vaultHash, 28, 'vaultHash'),
    hexOfLength(f.mandateRef, 28, 'mandateRef'),
    hexOfLength(f.mandateHash, 32, 'mandateHash'),
    uintBE(BigInt(f.mandateVersion), 4),
    hexOfLength(f.actionHash, 32, 'actionHash'),
    Uint8Array.of(f.actionType),
    hexOfLength(f.assetPolicy, 28, 'assetPolicy'),
    Uint8Array.of(assetName.length),
    assetName,
    uintBE(inRange(f.amount, 'amount'), 8),
    credential(recipient.payment, 0, 1),
    stake,
    uintBE(inRange(f.nonce, 'nonce'), 8),
    uintBE(inRange(f.validUntil, 'validUntil'), 8),
    Uint8Array.of(f.requiresPrincipal ? 1 : 0),
    f.verificationRef === null ? new Uint8Array(32) : hexOfLength(f.verificationRef, 32, 'verificationRef'),
  );
}

export function authorizationDigest(f: AuthorizationFields): Uint8Array {
  return blake2b256(encodeAuthorization(f));
}

function toRecordFields(f: AuthorizationFields): AuthorizationRecordFields {
  if (f.validUntil > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('validUntil: beyond safe integer');
  return {
    chain_tag: f.chainTag,
    vault_hash: f.vaultHash.toLowerCase(),
    mandate_ref: f.mandateRef.toLowerCase(),
    mandate_hash: f.mandateHash.toLowerCase(),
    mandate_version: f.mandateVersion,
    action_hash: f.actionHash.toLowerCase(),
    action_type: f.actionType,
    asset_policy: f.assetPolicy.toLowerCase(),
    asset_name: f.assetName.toLowerCase(),
    amount: f.amount.toString(),
    recipient: f.recipient,
    nonce: f.nonce.toString(),
    valid_until: Number(f.validUntil),
    requires_principal: f.requiresPrincipal,
    verification_ref: f.verificationRef === null ? null : f.verificationRef.toLowerCase(),
  };
}

export function fieldsFromRecord(r: AuthorizationRecord): AuthorizationFields {
  const x = r.fields;
  return {
    chainTag: x.chain_tag,
    vaultHash: x.vault_hash,
    mandateRef: x.mandate_ref,
    mandateHash: x.mandate_hash,
    mandateVersion: x.mandate_version,
    actionHash: x.action_hash,
    actionType: x.action_type,
    assetPolicy: x.asset_policy,
    assetName: x.asset_name,
    amount: BigInt(x.amount),
    recipient: x.recipient,
    nonce: BigInt(x.nonce),
    validUntil: BigInt(x.valid_until),
    requiresPrincipal: x.requires_principal,
    verificationRef: x.verification_ref,
  };
}

export function signAuthorization(f: AuthorizationFields, engineSecretKey: Uint8Array): AuthorizationRecord {
  const fields = toRecordFields(f);
  const canonical = fieldsFromRecord({ fields } as AuthorizationRecord);
  const message = encodeAuthorization(canonical);
  const digest = blake2b256(message);
  return {
    schema: 'authorization/v0.1',
    message_hex: bytesToHex(message),
    digest_hex: bytesToHex(digest),
    signature_hex: bytesToHex(signBytes(digest, engineSecretKey)),
    engine_public_key: bytesToHex(publicKeyFromSecret(engineSecretKey)),
    fields,
  };
}

export function verifyAuthorizationRecord(r: AuthorizationRecord, expectedEnginePublicKeyHex: string): boolean {
  try {
    if (r.engine_public_key.toLowerCase() !== expectedEnginePublicKeyHex.toLowerCase()) return false;
    const message = encodeAuthorization(fieldsFromRecord(r));
    if (bytesToHex(message) !== r.message_hex.toLowerCase()) return false;
    const digest = blake2b256(message);
    if (bytesToHex(digest) !== r.digest_hex.toLowerCase()) return false;
    return verifyBytes(
      hexOfLength(r.signature_hex, 64, 'signature'),
      digest,
      hexOfLength(expectedEnginePublicKeyHex, 32, 'enginePublicKey'),
    );
  } catch {
    return false;
  }
}
