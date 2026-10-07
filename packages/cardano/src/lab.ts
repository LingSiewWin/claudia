// Attack Lab (M-LAB only). Nothing here may read the M-001 engine key: keys arrive as arguments and the
// lab runner reads only M_LAB_* names (test/isolation.test.ts).
import {
  type AuthorizationRecord,
  type AuthorizationRecordFields,
  authorizationDigest,
  bytesToHex,
  encodeAuthorization,
  fieldsFromRecord,
  publicKeyFromSecret,
  signBytes,
} from '@authority/core';
import type { UTxO } from '@meshsdk/core';
import type { Wallet } from './build';
import type { Deployment } from './deployment';
import type { AnchorState, VaultState } from './state';
import type { ReleaseInput } from './txs';

/**
 * Signs exactly the fields it is given with the lab engine key, bypassing the issuance gate: the
 * compromised-engine model of the Attack Lab, where the vault is the only guard left.
 */
export function signWithEngineKey(fields: AuthorizationRecordFields, engineSecretKey: Uint8Array): AuthorizationRecord {
  const typed = fieldsFromRecord({ fields } as AuthorizationRecord);
  const digest = authorizationDigest(typed);
  return {
    schema: 'authorization/v0.1',
    message_hex: bytesToHex(encodeAuthorization(typed)),
    digest_hex: bytesToHex(digest),
    signature_hex: bytesToHex(signBytes(digest, engineSecretKey)),
    engine_public_key: bytesToHex(publicKeyFromSecret(engineSecretKey)),
    fields,
  };
}

export interface LabContext {
  deployment: Deployment;
  anchor: AnchorState;
  vault: VaultState;
  refScript: UTxO;
  /** The executor's fee wallet; also the attacker's payout address in recipient swaps. */
  executor: Wallet;
  engineSecretKey: Uint8Array;
  /** AWS (demo vendor) payout address. */
  payee: string;
  actionHash: string;
  nowMs: number;
}

/** A lab authorization: 0.50 USDM to the payee, next nonce, 10-minute expiry, then `overrides`. */
export function labRecord(ctx: LabContext, overrides: Partial<AuthorizationRecordFields> = {}): AuthorizationRecord {
  const a = ctx.anchor.datum;
  return signWithEngineKey(
    {
      chain_tag: 0,
      vault_hash: ctx.deployment.vault.hash,
      mandate_ref: ctx.deployment.anchor.policy,
      mandate_hash: a.mandate_hash,
      mandate_version: a.version,
      action_hash: ctx.actionHash,
      action_type: 1,
      asset_policy: a.asset_policy,
      asset_name: a.asset_name,
      amount: '500000',
      recipient: ctx.payee,
      nonce: (ctx.vault.datum.last_nonce + 1n).toString(),
      valid_until: Math.min(ctx.nowMs + 600_000, Number(a.valid_until)),
      requires_principal: false,
      verification_ref: null,
      ...overrides,
    },
    ctx.engineSecretKey,
  );
}

export const labRelease = (ctx: LabContext, record: AuthorizationRecord): ReleaseInput => ({
  deployment: ctx.deployment,
  anchor: ctx.anchor,
  vault: ctx.vault,
  refScript: ctx.refScript,
  record,
  wallet: ctx.executor,
  nowMs: ctx.nowMs,
  mandateLabel: `${ctx.deployment.mandate_id}@${ctx.anchor.datum.version}`,
  logHead: null,
});
