//// Rebuilds the exact authorization message bytes from typed fields.
//// Every fixed-width field is length-checked so the encoding is injective:
//// two different `Authorization` values can never produce the same bytes.

use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray
use authority/types.{Authorization}
use cardano/address.{Address, Inline, Script, VerificationKey}

pub const domain: ByteArray = "AGENT_AUTHORIZATION_V1"

fn fixed(bytes: ByteArray, size: Int) -> ByteArray {
  expect bytearray.length(bytes) == size
  bytes
}

/// Unsigned big-endian, fixed width. Halts on negative values or overflow.
fn uint(value: Int, size: Int) -> ByteArray {
  expect value >= 0
  bytearray.from_int_big_endian(value, size)
}

fn stake_bytes(tag: Int, hash: ByteArray) -> ByteArray {
  when tag is {
    0 -> {
      expect hash == ""
      #"00"
    }
    1 | 2 -> bytearray.concat(uint(tag, 1), fixed(hash, 28))
    _ -> fail @"recipient_stake_tag"
  }
}

/// Checks shape only: field widths, tag and flag ranges, unsigned ints that
/// fit their width. Semantic rules (amount > 0, chain_tag in {0, 1},
/// action_type = 1, mandate_version >= 1, nonce >= 1) are enforced by the vault.
pub fn encode(a: Authorization) -> ByteArray {
  expect a.recipient_pay_tag == 0 || a.recipient_pay_tag == 1
  expect a.requires_principal == 0 || a.requires_principal == 1
  let name_len = bytearray.length(a.asset_name)
  expect name_len <= 32
  [
    domain,
    uint(a.chain_tag, 1),
    fixed(a.vault_hash, 28),
    fixed(a.mandate_ref, 28),
    fixed(a.mandate_hash, 32),
    uint(a.mandate_version, 4),
    fixed(a.action_hash, 32),
    uint(a.action_type, 1),
    fixed(a.asset_policy, 28),
    uint(name_len, 1),
    a.asset_name,
    uint(a.amount, 8),
    uint(a.recipient_pay_tag, 1),
    fixed(a.recipient_pay_hash, 28),
    stake_bytes(a.recipient_stake_tag, a.recipient_stake_hash),
    uint(a.nonce, 8),
    uint(a.valid_until, 8),
    uint(a.requires_principal, 1),
    fixed(a.verification_ref, 32),
  ]
    |> list.foldr(#"", bytearray.concat)
}

pub fn digest(a: Authorization) -> ByteArray {
  blake2b_256(encode(a))
}

/// The Plutus address the authorization pays (fields 13-16).
/// Precondition: the same value went through `digest`, which validated the
/// tags and hash lengths. This function does not re-check hash lengths.
pub fn recipient_address(a: Authorization) -> Address {
  let payment = when a.recipient_pay_tag is {
    0 -> VerificationKey(a.recipient_pay_hash)
    1 -> Script(a.recipient_pay_hash)
    _ -> fail @"recipient_pay_tag"
  }
  let stake = when a.recipient_stake_tag is {
    0 -> None
    1 -> Some(Inline(VerificationKey(a.recipient_stake_hash)))
    2 -> Some(Inline(Script(a.recipient_stake_hash)))
    _ -> fail @"recipient_stake_tag"
  }
  Address { payment_credential: payment, stake_credential: stake }
}
