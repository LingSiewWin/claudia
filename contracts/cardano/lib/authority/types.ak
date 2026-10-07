//// On-chain data shapes shared by the mandate anchor and the vault.
//// Constructor order is part of the wire format: do not reorder.

pub type AnchorStatus {
  Active
  Revoked
}

pub type AnchorDatum {
  mandate_hash: ByteArray,
  version: Int,
  status: AnchorStatus,
  engine_vkey: ByteArray,
  principal_pkh: ByteArray,
  approver_pkh: ByteArray,
  asset_policy: ByteArray,
  asset_name: ByteArray,
  autonomous_limit: Int,
  hard_cap: Int,
  daily_cap: Int,
  treasury_minimum: Int,
  valid_until: Int,
}

pub type AnchorRedeemer {
  Update { new: AnchorDatum }
  Revoke
}

pub type VaultDatum {
  last_nonce: Int,
  day_index: Int,
  spent_today: Int,
}

/// Fields 2-20 of the authorization message, in message order.
/// Field 10 (asset_name_len) is derived from `asset_name`.
pub type Authorization {
  chain_tag: Int,
  vault_hash: ByteArray,
  mandate_ref: ByteArray,
  mandate_hash: ByteArray,
  mandate_version: Int,
  action_hash: ByteArray,
  action_type: Int,
  asset_policy: ByteArray,
  asset_name: ByteArray,
  amount: Int,
  recipient_pay_tag: Int,
  recipient_pay_hash: ByteArray,
  recipient_stake_tag: Int,
  recipient_stake_hash: ByteArray,
  nonce: Int,
  valid_until: Int,
  requires_principal: Int,
  verification_ref: ByteArray,
}

pub type VaultRedeemer {
  Release { auth: Authorization, signature: ByteArray }
  Deposit
  PrincipalWithdraw
}

pub const anchor_token_name: ByteArray = "MANDATE"

pub const vault_token_name: ByteArray = "VAULT"

pub const day_ms: Int = 86_400_000

pub const max_window_ms: Int = 600_000

/// Escalation bond held in escrow while a human is interrupted
/// (packages/cardano/src/bond.ts `BondDatum`, same field order).
/// `approval_ref = sha256(utf8(approval_id))`; `locked_until` is POSIX ms.
pub type BondDatum {
  approval_ref: ByteArray,
  action_hash: ByteArray,
  mandate_ref: ByteArray,
  agent_pkh: ByteArray,
  agent_stake: Option<ByteArray>,
  approver_pkh: ByteArray,
  amount: Int,
  locked_until: Int,
}

pub type BondRedeemer {
  Refund
  Capture
}
