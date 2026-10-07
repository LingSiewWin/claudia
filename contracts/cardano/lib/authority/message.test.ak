//// Guards of the authorization encoder and genuineness of the signed fixtures.
//// Hand-written: not owned by the generator.

use aiken/collection/list
use aiken/crypto.{verify_ed25519_signature}
use aiken/primitive/bytearray
use authority/fixtures.{Signed, engine_vkey, release_base}
use authority/message
use authority/types.{Authorization}

/// True whenever `encode` returns, so a `fail` test passes only if it halts.
fn encodes(a: Authorization) -> Bool {
  bytearray.length(message.encode(a)) > 0
}

fn verifies(s: Signed) -> Bool {
  verify_ed25519_signature(engine_vkey, message.digest(s.auth), s.signature)
}

test encode_rejects_amount_over_u64() fail {
  encodes(
    Authorization { ..release_base.auth, amount: 18_446_744_073_709_551_616 },
  )
}

test encode_rejects_chain_tag_over_u8() fail {
  encodes(Authorization { ..release_base.auth, chain_tag: 256 })
}

test encode_rejects_mandate_version_over_u32() fail {
  encodes(Authorization { ..release_base.auth, mandate_version: 4_294_967_296 })
}

test encode_rejects_short_vault_hash() fail {
  encodes(
    Authorization {
      ..release_base.auth,
      vault_hash: bytearray.replicate(27, 0xaa),
    },
  )
}

test encode_rejects_long_vault_hash() fail {
  encodes(
    Authorization {
      ..release_base.auth,
      vault_hash: bytearray.replicate(29, 0xaa),
    },
  )
}

test encode_rejects_key_stake_without_hash() fail {
  encodes(
    Authorization {
      ..release_base.auth,
      recipient_stake_tag: 1,
      recipient_stake_hash: "",
    },
  )
}

test encode_rejects_short_verification_ref() fail {
  encodes(
    Authorization {
      ..release_base.auth,
      verification_ref: bytearray.replicate(31, 0xf0),
    },
  )
}

test encode_rejects_long_asset_name() fail {
  encodes(
    Authorization {
      ..release_base.auth,
      asset_name: bytearray.replicate(33, 0xab),
    },
  )
}

test encode_rejects_no_stake_with_hash() fail {
  encodes(
    Authorization {
      ..release_base.auth,
      recipient_stake_tag: 0,
      recipient_stake_hash: bytearray.replicate(28, 0x22),
    },
  )
}

test encode_rejects_unknown_stake_tag() fail {
  encodes(
    Authorization {
      ..release_base.auth,
      recipient_stake_tag: 3,
      recipient_stake_hash: bytearray.replicate(28, 0x22),
    },
  )
}

test encode_rejects_unknown_pay_tag() fail {
  encodes(Authorization { ..release_base.auth, recipient_pay_tag: 2 })
}

test encode_rejects_requires_principal_2() fail {
  encodes(Authorization { ..release_base.auth, requires_principal: 2 })
}

test encode_rejects_negative_nonce() fail {
  encodes(Authorization { ..release_base.auth, nonce: -1 })
}

test genuine_fixtures_verify_under_engine_key() {
  [
    fixtures.release_base,
    fixtures.release_at_autonomous,
    fixtures.release_above_autonomous,
    fixtures.release_above_autonomous_unflagged,
    fixtures.release_flagged_small,
    fixtures.release_at_hard_cap,
    fixtures.release_above_hard_cap,
    fixtures.release_old_version,
    fixtures.release_other_mandate_hash,
    fixtures.release_other_mandate_ref,
    fixtures.release_mainnet,
    fixtures.release_other_vault,
    fixtures.release_action_type_2,
    fixtures.release_other_asset_name,
    fixtures.release_other_asset_policy,
    fixtures.release_amount_zero,
    fixtures.release_to_vault,
  ]
    |> list.all(verifies)
}

test other_key_signature_does_not_verify() {
  !verifies(fixtures.release_other_key)
}

test proposal_signature_does_not_verify_as_authorization() {
  !verifies(fixtures.release_proposal_signature)
}
