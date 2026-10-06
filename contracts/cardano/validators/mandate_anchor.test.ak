use aiken/primitive/bytearray
use authority/testkit.{
  anchor_input, anchor_mint_tx, anchor_ref, anchor_seed, anchor_spend_tx,
  anchor_utxo, attacker, cfo, fee_input, intruder, key_address, mandate,
}
use authority/types.{
  Active, AnchorDatum, AnchorRedeemer, Revoke, Revoked, Update,
  anchor_token_name,
}
use cardano/address
use cardano/assets
use cardano/transaction.{DatumHash, Input, Output, Transaction}
use mandate_anchor

// ## Harness

fn mint(tx: Transaction) -> Bool {
  mandate_anchor.mandate_anchor.mint(anchor_seed, Void, anchor_ref, tx)
}

fn mint_with(d: AnchorDatum) -> Bool {
  mint(anchor_mint_tx(d))
}

fn spend(old: AnchorDatum, redeemer: AnchorRedeemer, tx: Transaction) -> Bool {
  mandate_anchor.mandate_anchor.spend(
    anchor_seed,
    Some(old),
    redeemer,
    anchor_utxo,
    tx,
  )
}

fn first_output(tx: Transaction, f: fn(Output) -> Output) -> Transaction {
  when tx.outputs is {
    [o, ..rest] -> Transaction { ..tx, outputs: [f(o), ..rest] }
    [] -> tx
  }
}

const bumped: AnchorDatum =
  AnchorDatum { ..mandate, version: 4, hard_cap: 40_000_000 }

const revoked: AnchorDatum =
  AnchorDatum { ..mandate, status: Revoked, version: 4 }

const new_principal: ByteArray =
  #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

// ## M1-M5: one-shot creation

test m_creates_anchor() {
  mint_with(mandate)
}

test m1_seed_not_spent() {
  !mint(Transaction { ..anchor_mint_tx(mandate), inputs: [fee_input()] })
}

test m2_two_tokens() {
  let tx = anchor_mint_tx(mandate)
  !mint(
    Transaction {
      ..tx,
      mint: assets.from_asset(anchor_ref, anchor_token_name, 2),
    }
      |> first_output(
          fn(o) {
            Output {
              ..o,
              value: assets.add(o.value, anchor_ref, anchor_token_name, 1),
            }
          },
        ),
  )
}

test m2_second_name_minted() fail {
  let tx = anchor_mint_tx(mandate)
  mint(Transaction { ..tx, mint: assets.add(tx.mint, anchor_ref, "OTHER", 1) })
}

test m2_burn_rejected() fail {
  let tx = anchor_mint_tx(mandate)
  mint(
    Transaction {
      ..tx,
      mint: assets.from_asset(anchor_ref, anchor_token_name, -1),
      outputs: [],
    },
  )
}

test m3_to_key_address() {
  !mint(
    anchor_mint_tx(mandate)
      |> first_output(fn(o) { Output { ..o, address: key_address(attacker) } }),
  )
}

test m3_revoked_at_creation() {
  !mint_with(AnchorDatum { ..mandate, status: Revoked })
}

test m3_datum_by_hash() fail {
  mint(
    anchor_mint_tx(mandate)
      |> first_output(
          fn(o) {
            Output {
              ..o,
              datum: DatumHash(
                #"0000000000000000000000000000000000000000000000000000000000000000",
              ),
            }
          },
        ),
  )
}

test m4_version_zero() {
  !mint_with(AnchorDatum { ..mandate, version: 0 })
}

test m4_autonomous_limit_zero() {
  !mint_with(AnchorDatum { ..mandate, autonomous_limit: 0 })
}

test m4_hard_cap_below_autonomous() {
  !mint_with(AnchorDatum { ..mandate, hard_cap: 9_999_999 })
}

test m4_daily_cap_below_autonomous() {
  !mint_with(AnchorDatum { ..mandate, daily_cap: 9_999_999 })
}

test m4_negative_treasury_minimum() {
  !mint_with(AnchorDatum { ..mandate, treasury_minimum: -1 })
}

test m4_short_mandate_hash() {
  !mint_with(
    AnchorDatum {
      ..mandate,
      mandate_hash: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
  )
}

test m4_long_mandate_hash() {
  !mint_with(
    AnchorDatum {
      ..mandate,
      mandate_hash: bytearray.push(mandate.mandate_hash, 0),
    },
  )
}

test m4_short_engine_key() {
  !mint_with(
    AnchorDatum {
      ..mandate,
      engine_vkey: #"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f",
    },
  )
}

test m4_short_principal() {
  !mint_with(
    AnchorDatum {
      ..mandate,
      principal_pkh: #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
    },
  )
}

test m4_short_asset_policy() {
  !mint_with(
    AnchorDatum {
      ..mandate,
      asset_policy: #"16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722dd",
    },
  )
}

test m4_long_asset_name() {
  !mint_with(
    AnchorDatum {
      ..mandate,
      asset_name: #"000000000000000000000000000000000000000000000000000000000000000000",
    },
  )
}

test m4_long_engine_key() {
  !mint_with(
    AnchorDatum {
      ..mandate,
      engine_vkey: bytearray.push(mandate.engine_vkey, 0),
    },
  )
}

test m4_long_principal() {
  !mint_with(
    AnchorDatum {
      ..mandate,
      principal_pkh: bytearray.push(mandate.principal_pkh, 0),
    },
  )
}

test m4_long_asset_policy() {
  !mint_with(
    AnchorDatum {
      ..mandate,
      asset_policy: bytearray.push(mandate.asset_policy, 0),
    },
  )
}

test m_accepts_hard_cap_equal_to_autonomous_limit() {
  mint_with(AnchorDatum { ..mandate, hard_cap: mandate.autonomous_limit })
}

test m_accepts_daily_cap_equal_to_autonomous_limit() {
  mint_with(AnchorDatum { ..mandate, daily_cap: mandate.autonomous_limit })
}

test m_accepts_zero_treasury_minimum() {
  mint_with(AnchorDatum { ..mandate, treasury_minimum: 0 })
}

test m_accepts_32_byte_asset_name() {
  mint_with(
    AnchorDatum {
      ..mandate,
      asset_name: #"0000000000000000000000000000000000000000000000000000000000000000",
    },
  )
}

test m5_not_signed_by_principal() {
  !mint(
    Transaction { ..anchor_mint_tx(mandate), extra_signatories: [intruder] },
  )
}

// ## U1: Update

test update_by_principal() {
  spend(mandate, Update { new: bumped }, anchor_spend_tx(mandate, bumped))
}

test update_rotates_engine_key() {
  let rotated = AnchorDatum {
    ..mandate,
    version: 4,
    engine_vkey: #"0101010101010101010101010101010101010101010101010101010101010101",
  }
  spend(mandate, Update { new: rotated }, anchor_spend_tx(mandate, rotated))
}

test update_without_principal() {
  !spend(
    mandate,
    Update { new: bumped },
    Transaction {
      ..anchor_spend_tx(mandate, bumped),
      extra_signatories: [intruder],
    },
  )
}

test update_signed_only_by_new_principal() {
  let takeover = AnchorDatum { ..bumped, principal_pkh: intruder }
  !spend(
    mandate,
    Update { new: takeover },
    Transaction {
      ..anchor_spend_tx(mandate, takeover),
      extra_signatories: [intruder],
    },
  )
}

test update_hands_over_to_new_principal() {
  let handover = AnchorDatum { ..bumped, principal_pkh: new_principal }
  spend(
    mandate,
    Update { new: handover },
    Transaction {
      ..anchor_spend_tx(mandate, handover),
      extra_signatories: [cfo, new_principal],
    },
  )
}

test update_handover_without_new_principal() {
  let handover = AnchorDatum { ..bumped, principal_pkh: new_principal }
  !spend(mandate, Update { new: handover }, anchor_spend_tx(mandate, handover))
}

test update_to_max_u32_version() {
  let top = AnchorDatum { ..bumped, version: 4_294_967_295 }
  spend(mandate, Update { new: top }, anchor_spend_tx(mandate, top))
}

test update_version_over_u32() {
  let over = AnchorDatum { ..bumped, version: 4_294_967_296 }
  !spend(mandate, Update { new: over }, anchor_spend_tx(mandate, over))
}

test update_same_version() {
  let same = AnchorDatum { ..bumped, version: 3 }
  !spend(mandate, Update { new: same }, anchor_spend_tx(mandate, same))
}

test update_lower_version() {
  let lower = AnchorDatum { ..bumped, version: 2 }
  !spend(mandate, Update { new: lower }, anchor_spend_tx(mandate, lower))
}

test update_invalid_limits() {
  let broken = AnchorDatum { ..bumped, hard_cap: 1 }
  !spend(mandate, Update { new: broken }, anchor_spend_tx(mandate, broken))
}

test update_output_differs_from_redeemer() {
  let sneaky = AnchorDatum { ..bumped, hard_cap: 1_000_000_000 }
  !spend(mandate, Update { new: bumped }, anchor_spend_tx(mandate, sneaky))
}

test update_nft_leaves_script() {
  !spend(
    mandate,
    Update { new: bumped },
    anchor_spend_tx(mandate, bumped)
      |> first_output(fn(o) { Output { ..o, address: key_address(attacker) } }),
  )
}

test update_stake_credential_changed() {
  !spend(
    mandate,
    Update { new: bumped },
    anchor_spend_tx(mandate, bumped)
      |> first_output(
          fn(o) {
            Output {
              ..o,
              address: address.with_delegation_key(o.address, attacker),
            }
          },
        ),
  )
}

test update_reactivates_revoked_anchor() {
  let active = AnchorDatum { ..mandate, version: 5, status: Active }
  spend(revoked, Update { new: active }, anchor_spend_tx(revoked, active))
}

test update_unrevoke_without_principal() {
  let active = AnchorDatum { ..mandate, version: 5, status: Active }
  !spend(
    revoked,
    Update { new: active },
    Transaction {
      ..anchor_spend_tx(revoked, active),
      extra_signatories: [intruder],
    },
  )
}

test update_junk_utxo_without_nft() {
  // A UTxO sent to the anchor address with a forged datum naming the intruder.
  let forged = AnchorDatum { ..mandate, principal_pkh: intruder }
  let next = AnchorDatum { ..forged, version: 4 }
  let tx = anchor_spend_tx(forged, next)
  let junk = Input {
    ..anchor_input(forged),
    output: Output {
      ..anchor_input(forged).output,
      value: assets.from_lovelace(2_000_000),
    },
  }
  !spend(
    forged,
    Update { new: next },
    Transaction {
      ..tx,
      inputs: [junk, fee_input()],
      extra_signatories: [intruder],
    },
  )
}

// ## U2: Revoke

test revoke_by_principal() {
  spend(mandate, Revoke, anchor_spend_tx(mandate, revoked))
}

test revoke_without_principal() {
  !spend(
    mandate,
    Revoke,
    Transaction {
      ..anchor_spend_tx(mandate, revoked),
      extra_signatories: [intruder],
    },
  )
}

test revoke_skips_a_version() {
  !spend(
    mandate,
    Revoke,
    anchor_spend_tx(mandate, AnchorDatum { ..revoked, version: 5 }),
  )
}

test revoke_changes_limits() {
  !spend(
    mandate,
    Revoke,
    anchor_spend_tx(mandate, AnchorDatum { ..revoked, hard_cap: 1_000_000_000 }),
  )
}

test revoke_keeps_status_active() {
  !spend(
    mandate,
    Revoke,
    anchor_spend_tx(mandate, AnchorDatum { ..revoked, status: Active }),
  )
}

test revoke_nft_leaves_script() {
  !spend(
    mandate,
    Revoke,
    anchor_spend_tx(mandate, revoked)
      |> first_output(fn(o) { Output { ..o, address: key_address(attacker) } }),
  )
}
