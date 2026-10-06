use aiken/collection/list
use aiken/crypto.{verify_ed25519_signature}
use aiken/fuzz
use aiken/interval
use aiken/primitive/bytearray
use authority/fixtures.{
  Signed, release_above_autonomous, release_above_autonomous_unflagged,
  release_above_hard_cap, release_action_type_2, release_amount_zero,
  release_at_autonomous, release_at_hard_cap, release_base,
  release_flagged_small, release_mainnet, release_old_version,
  release_other_asset_name, release_other_asset_policy, release_other_key,
  release_other_mandate_hash, release_other_mandate_ref, release_other_vault,
  release_proposal_signature, release_to_vault, release_version_cap,
}
use authority/message
use authority/testkit.{
  ReleaseCase, anchor_input, anchor_ref, attacker, aws, cfo, chain_tag,
  deposit_tx, edit_output, fee_input, intruder, key_address, lower, mandate,
  recipient_ix, release_case, release_tx, start_balance, today, upper, usdm_name,
  usdm_policy, vault_address, vault_hash, vault_ix, vault_mint_tx, vault_output,
  vault_seed, vault_utxo, withdraw_tx,
}
use authority/types.{
  AnchorDatum, Authorization, Deposit, PrincipalWithdraw, Release, Revoked,
  VaultDatum, VaultRedeemer, anchor_token_name, vault_token_name,
}
use cardano/address
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use vault

// ## Harness

fn spend(datum: VaultDatum, redeemer: VaultRedeemer, tx: Transaction) -> Bool {
  let raw: Data = datum
  vault.vault.spend(
    anchor_ref,
    chain_tag,
    vault_seed,
    Some(raw),
    redeemer,
    vault_utxo,
    tx,
  )
}

fn release(c: ReleaseCase, tx: Transaction) -> Bool {
  spend(
    c.datum,
    Release { auth: c.signed.auth, signature: c.signed.signature },
    tx,
  )
}

fn settles(c: ReleaseCase) -> Bool {
  release(c, release_tx(c))
}

/// Adversarial cases assume a stolen engine key: the signature is genuine, so
/// a rejection proves the invariant under test, not R6.
fn genuine(s: Signed) -> Bool {
  verify_ed25519_signature(
    fixtures.engine_vkey,
    message.digest(s.auth),
    s.signature,
  )
}

fn edit_vault_output(tx: Transaction, f: fn(Output) -> Output) -> Transaction {
  edit_output(tx, vault_ix, f)
}

fn with_value(o: Output, f: fn(assets.Assets) -> assets.Assets) -> Output {
  Output { ..o, value: f(o.value) }
}

fn drop_thread(o: Output) -> Output {
  with_value(o, fn(v) { assets.add(v, vault_hash, vault_token_name, -1) })
}

// ## Happy paths

test release_settles_within_autonomous_limit() {
  settles(release_case(release_base))
}

test release_settles_above_autonomous_limit_with_cfo() {
  settles(
    ReleaseCase { ..release_case(release_above_autonomous), signers: [cfo] },
  )
}

// ## R0: only the thread-token UTxO

test r0_fake_vault_utxo_without_thread_token() {
  let c = release_case(release_base)
  let tx = release_tx(c)
  let tx = Transaction {
    ..tx,
    inputs: [
      Input {
        output_reference: vault_utxo,
        output: drop_thread(vault_output(c.datum, c.balance)),
      },
      fee_input(),
    ],
  }
    |> edit_vault_output(drop_thread)
  !release(c, tx)
}

test r0_deposit_into_fake_vault_utxo() {
  let tx = deposit_tx()
  let tx = Transaction {
    ..tx,
    inputs: [
      Input {
        output_reference: vault_utxo,
        output: drop_thread(vault_output(testkit.fresh, start_balance)),
      },
      fee_input(),
    ],
  }
    |> edit_output(0, drop_thread)
  !spend(testkit.fresh, Deposit, tx)
}

// ## R1: one vault input

test r1_second_vault_input() {
  let c = release_case(release_base)
  let tx = release_tx(c)
  let junk = Input {
    output_reference: testkit.fee_utxo,
    output: Output {
      address: vault_address(),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
  !release(c, Transaction { ..tx, inputs: [junk, ..tx.inputs] })
}

// ## R2: authentic anchor reference input

test r2_missing_anchor() fail {
  let c = release_case(release_base)
  release(c, Transaction { ..release_tx(c), reference_inputs: [] })
}

test r2_forged_anchor_without_nft() fail {
  let c = release_case(release_base)
  let forged = Input {
    ..anchor_input(mandate),
    output: Output {
      ..testkit.anchor_output(
        AnchorDatum { ..mandate, hard_cap: 1_000_000_000 },
      ),
      value: assets.from_lovelace(2_000_000),
    },
  }
  release(c, Transaction { ..release_tx(c), reference_inputs: [forged] })
}

test r2_forged_anchor_is_ignored_next_to_real_one() {
  let c = release_case(release_base)
  let tx = release_tx(c)
  let forged = Input {
    ..anchor_input(mandate),
    output: Output {
      ..testkit.anchor_output(mandate),
      value: assets.from_lovelace(2_000_000),
    },
  }
  release(
    c,
    Transaction { ..tx, reference_inputs: [forged, ..tx.reference_inputs] },
  )
}

test r2_anchor_of_other_mandate() fail {
  // A real-looking anchor the attacker minted under another policy.
  let c = release_case(release_base)
  let other = Input {
    ..anchor_input(mandate),
    output: Output {
      address: address.from_script(attacker),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(attacker, anchor_token_name, 1),
      datum: InlineDatum(AnchorDatum { ..mandate, hard_cap: 1_000_000_000 }),
      reference_script: None,
    },
  }
  release(c, Transaction { ..release_tx(c), reference_inputs: [other] })
}

test r2_anchor_nft_at_key_address() fail {
  let c = release_case(release_base)
  let moved = Input {
    ..anchor_input(mandate),
    output: Output {
      ..testkit.anchor_output(mandate),
      address: key_address(attacker),
    },
  }
  release(c, Transaction { ..release_tx(c), reference_inputs: [moved] })
}

test r2_anchor_spent_instead_of_referenced() fail {
  let c = release_case(release_base)
  let tx = release_tx(c)
  release(
    c,
    Transaction {
      ..tx,
      inputs: [anchor_input(mandate), ..tx.inputs],
      reference_inputs: [],
    },
  )
}

test r2_two_anchor_inputs() fail {
  let c = release_case(release_base)
  let tx = release_tx(c)
  release(
    c,
    Transaction {
      ..tx,
      reference_inputs: list.concat(tx.reference_inputs, tx.reference_inputs),
    },
  )
}

test r2_anchor_datum_by_hash() fail {
  let c = release_case(release_base)
  let moved = Input {
    ..anchor_input(mandate),
    output: Output { ..testkit.anchor_output(mandate), datum: DatumHash(#"00") },
  }
  release(c, Transaction { ..release_tx(c), reference_inputs: [moved] })
}

test r2_anchor_datum_wrong_type() fail {
  let c = release_case(release_base)
  let moved = Input {
    ..anchor_input(mandate),
    output: Output { ..testkit.anchor_output(mandate), datum: InlineDatum(42) },
  }
  release(c, Transaction { ..release_tx(c), reference_inputs: [moved] })
}

test r2_anchor_datum_wrong_fields() fail {
  let c = release_case(release_base)
  let moved = Input {
    ..anchor_input(mandate),
    output: Output {
      ..testkit.anchor_output(mandate),
      datum: InlineDatum(
        VaultDatum { last_nonce: 0, day_index: 0, spent_today: 0 },
      ),
    },
  }
  release(c, Transaction { ..release_tx(c), reference_inputs: [moved] })
}

// ## R3: anchor active

test r3_revoked_anchor() {
  let c = ReleaseCase {
    ..release_case(release_base),
    anchor: AnchorDatum { ..mandate, status: Revoked },
  }
  !settles(c)
}

test r3_active_at_version_cap() {
  settles(
    ReleaseCase {
      ..release_case(release_version_cap),
      anchor: AnchorDatum { ..mandate, version: 4_294_967_295 },
    },
  )
}

test r3_revoked_at_version_cap() {
  genuine(release_version_cap) && !settles(
    ReleaseCase {
      ..release_case(release_version_cap),
      anchor: AnchorDatum { ..mandate, status: Revoked, version: 4_294_967_295 },
    },
  )
}

// ## R4: mandate ref, hash, version

test r4_old_version() {
  genuine(release_old_version) && !settles(release_case(release_old_version))
}

test r4_anchor_bumped_after_issue() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      anchor: AnchorDatum { ..mandate, version: 4 },
    },
  )
}

test r4_other_mandate_hash() {
  genuine(release_other_mandate_hash) && !settles(
    release_case(release_other_mandate_hash),
  )
}

test r4_other_mandate_ref() {
  genuine(release_other_mandate_ref) && !settles(
    release_case(release_other_mandate_ref),
  )
}

// ## R5: chain tag and vault hash

test r5_mainnet_authorization() {
  genuine(release_mainnet) && !settles(release_case(release_mainnet))
}

test r5_other_vault_authorization() {
  genuine(release_other_vault) && !settles(release_case(release_other_vault))
}

// ## R6: engine signature over the exact bytes

test r6_amount_swapped() {
  let swapped = Signed {
    ..release_base,
    auth: Authorization { ..release_base.auth, amount: 9_000_000 },
  }
  !settles(release_case(swapped))
}

test r6_recipient_swapped() {
  let swapped = Signed {
    ..release_base,
    auth: Authorization { ..release_base.auth, recipient_pay_hash: attacker },
  }
  !settles(
    ReleaseCase { ..release_case(swapped), pay_to: key_address(attacker) },
  )
}

test r6_other_key() {
  !settles(release_case(release_other_key))
}

test r6_proposal_signature_is_not_an_authorization() {
  !settles(release_case(release_proposal_signature))
}

test r6_truncated_signature() fail {
  let s = Signed {
    ..release_base,
    signature: bytearray.take(release_base.signature, 63),
  }
  settles(release_case(s))
}

test r6_field_boundary_shift() fail {
  // Same message bytes, one byte moved from vault_hash into mandate_ref.
  let a = release_base.auth
  let shifted = Authorization {
    ..a,
    vault_hash: bytearray.take(a.vault_hash, 27),
    mandate_ref: bytearray.concat(#"aa", a.mandate_ref),
  }
  message.encode(shifted) == message.encode(a)
}

// ## R7: validity window

test r7_upper_bound_equals_valid_until() {
  settles(
    ReleaseCase {
      ..release_case(release_base),
      lower: 1_799_999_500_000,
      upper: 1_800_000_000_000,
    },
  )
}

test r7_upper_bound_after_valid_until() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      lower: 1_799_999_500_001,
      upper: 1_800_000_000_001,
    },
  )
}

test r7_upper_bound_after_mandate_expiry() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      anchor: AnchorDatum { ..mandate, valid_until: upper - 1 },
    },
  )
}

test r7_window_exactly_ten_minutes() {
  settles(
    ReleaseCase {
      ..release_case(release_base),
      lower: 1_799_999_200_000,
      upper: 1_799_999_800_000,
    },
  )
}

test r7_window_over_ten_minutes() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      lower: 1_799_999_199_999,
      upper: 1_799_999_800_000,
    },
  )
}

test r7_unbounded_upper() fail {
  let c = release_case(release_base)
  release(
    c,
    Transaction { ..release_tx(c), validity_range: interval.after(lower) },
  )
}

test r7_unbounded_lower() fail {
  let c = release_case(release_base)
  release(
    c,
    Transaction { ..release_tx(c), validity_range: interval.before(upper) },
  )
}

// ## R8: nonce strictly increasing

test r8_replay_after_settlement() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      datum: VaultDatum {
        last_nonce: 1,
        day_index: today,
        spent_today: 8_420_000,
      },
      balance: start_balance - 8_420_000,
    },
  )
}

test r8_lower_nonce() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      datum: VaultDatum { last_nonce: 2, day_index: 0, spent_today: 0 },
    },
  )
}

// ## R9: action type, asset, positive amount

test r9_action_type() {
  genuine(release_action_type_2) && !settles(
    release_case(release_action_type_2),
  )
}

test r9_other_asset_name() {
  genuine(release_other_asset_name) && !settles(
    release_case(release_other_asset_name),
  )
}

test r9_other_asset_policy() {
  genuine(release_other_asset_policy) && !settles(
    release_case(release_other_asset_policy),
  )
}

test r9_zero_amount() {
  genuine(release_amount_zero) && !settles(release_case(release_amount_zero))
}

// ## R10: hard cap (daily cap and floor relaxed so only R10 can fail)

fn hard_cap_case(s: Signed) -> ReleaseCase {
  ReleaseCase {
    ..release_case(s),
    anchor: AnchorDatum { ..mandate, daily_cap: 100_000_000 },
    balance: 200_000_000,
    signers: [cfo],
  }
}

test r10_at_hard_cap() {
  settles(hard_cap_case(release_at_hard_cap))
}

test r10_above_hard_cap() {
  genuine(release_above_hard_cap) && !settles(
    hard_cap_case(release_above_hard_cap),
  )
}

// ## R11: CFO co-signature

test r11_at_autonomous_limit_without_cfo() {
  settles(release_case(release_at_autonomous))
}

test r11_above_limit_without_cfo() {
  !settles(release_case(release_above_autonomous))
}

test r11_above_limit_unflagged_without_cfo() {
  genuine(release_above_autonomous_unflagged) && !settles(
    release_case(release_above_autonomous_unflagged),
  )
}

/// Above the autonomous limit the engine must have flagged the authorization:
/// a principal signature does not rescue an inconsistent authorization.
test r11_above_limit_unflagged_with_cfo() {
  genuine(release_above_autonomous_unflagged) && !settles(
    ReleaseCase {
      ..release_case(release_above_autonomous_unflagged),
      signers: [cfo],
    },
  )
}

test r11_flagged_small_without_cfo() {
  !settles(release_case(release_flagged_small))
}

test r11_flagged_small_with_cfo() {
  settles(ReleaseCase { ..release_case(release_flagged_small), signers: [cfo] })
}

test r11_wrong_cosigner() {
  !settles(
    ReleaseCase {
      ..release_case(release_above_autonomous),
      signers: [intruder],
    },
  )
}

// ## R12: daily window

test r12_same_day_up_to_cap() {
  settles(
    ReleaseCase {
      ..release_case(release_base),
      datum: VaultDatum {
        last_nonce: 0,
        day_index: today,
        spent_today: 41_580_000,
      },
    },
  )
}

test r12_same_day_over_cap() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      datum: VaultDatum {
        last_nonce: 0,
        day_index: today,
        spent_today: 41_580_001,
      },
    },
  )
}

test r12_new_day_resets() {
  settles(
    ReleaseCase {
      ..release_case(release_base),
      datum: VaultDatum {
        last_nonce: 0,
        day_index: today - 1,
        spent_today: 50_000_000,
      },
    },
  )
}

test r12_day_in_the_past() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      datum: VaultDatum { last_nonce: 0, day_index: today + 1, spent_today: 0 },
    },
  )
}

test r12_first_ms_of_day_is_new_day() {
  settles(
    ReleaseCase {
      ..release_case(release_base),
      datum: VaultDatum {
        last_nonce: 0,
        day_index: today - 1,
        spent_today: 50_000_000,
      },
      lower: 1_799_971_200_000,
      upper: 1_799_971_500_000,
    },
  )
}

test r12_last_ms_of_day_is_same_day() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      datum: VaultDatum {
        last_nonce: 0,
        day_index: today - 1,
        spent_today: 50_000_000,
      },
      lower: 1_799_971_199_999,
      upper: 1_799_971_500_000,
    },
  )
}

test r12_new_day_claimed_from_upper_bound() {
  // The window straddles midnight. The attacker records the upper bound's
  // day to reset the counter; the day comes from the lower bound.
  let c = ReleaseCase {
    ..release_case(release_base),
    datum: VaultDatum {
      last_nonce: 0,
      day_index: today - 1,
      spent_today: 50_000_000,
    },
    lower: 1_799_971_199_999,
    upper: 1_799_971_500_000,
  }
  let tx = release_tx(c)
    |> edit_vault_output(
        fn(o) {
          Output {
            ..o,
            datum: InlineDatum(
              VaultDatum {
                last_nonce: 1,
                day_index: today,
                spent_today: 8_420_000,
              },
            ),
          }
        },
      )
  !release(c, tx)
}

test r13_continuing_datum_keeps_old_day() {
  let c = ReleaseCase {
    ..release_case(release_base),
    datum: VaultDatum {
      last_nonce: 0,
      day_index: today - 1,
      spent_today: 50_000_000,
    },
  }
  let tx = release_tx(c)
    |> edit_vault_output(
        fn(o) {
          Output {
            ..o,
            datum: InlineDatum(
              VaultDatum {
                last_nonce: 1,
                day_index: today - 1,
                spent_today: 8_420_000,
              },
            ),
          }
        },
      )
  !release(c, tx)
}

/// R12 across day boundaries: for any lower bound around three UTC midnights
/// and a datum from yesterday, today or tomorrow, the validator agrees with an
/// independent model of the calendar-day window.
test r12_daily_window_matches_model(
  (l, offset, spent) via fuzz.tuple3(
    fuzz.int_between(1_799_740_000_000, 1_799_999_700_000),
    fuzz.int_between(0, 2),
    fuzz.int_between(0, 50_000_000),
  ),
) {
  let amount = 8_420_000
  let day = l / 86_400_000
  let day_index = day - 1 + offset
  let expected = when offset is {
    0 -> amount <= 50_000_000
    1 -> spent + amount <= 50_000_000
    _ -> False
  }
  fuzz.label(
    when offset is {
      0 -> @"new day"
      1 -> @"same day"
      _ -> @"past day"
    },
  )
  fuzz.label(
    if expected {
      @"accepted"
    } else {
      @"rejected"
    },
  )
  settles(
    ReleaseCase {
      ..release_case(release_base),
      datum: VaultDatum { last_nonce: 0, day_index, spent_today: spent },
      lower: l,
      upper: l + 300_000,
    },
  ) == expected
}

// ## R13: one continuing output with the exact next datum

test r13_datum_reset() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(
          fn(o) { Output { ..o, datum: InlineDatum(testkit.fresh) } },
        ),
  )
}

test r13_spent_not_recorded() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(
          fn(o) {
            Output {
              ..o,
              datum: InlineDatum(
                VaultDatum { last_nonce: 1, day_index: today, spent_today: 0 },
              ),
            }
          },
        ),
  )
}

test r13_nonce_not_recorded() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(
          fn(o) {
            Output {
              ..o,
              datum: InlineDatum(
                VaultDatum {
                  last_nonce: 0,
                  day_index: today,
                  spent_today: 8_420_000,
                },
              ),
            }
          },
        ),
  )
}

test r13_datum_by_hash() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(
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

test r13_other_stake_credential() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(
          fn(o) {
            Output {
              ..o,
              address: address.with_delegation_key(vault_address(), attacker),
            }
          },
        ),
  )
}

test r13_reference_script_attached() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(
          fn(o) { Output { ..o, reference_script: Some(attacker) } },
        ),
  )
}

test r13_split_continuing_output() fail {
  let c = release_case(release_base)
  let tx = release_tx(c)
  let split = Output {
    address: vault_address(),
    value: assets.from_lovelace(2_000_000),
    datum: InlineDatum(testkit.fresh),
    reference_script: None,
  }
  release(c, Transaction { ..tx, outputs: [split, ..tx.outputs] })
}

// ## R14: exact value delta

test r14_skim_lovelace() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(with_value(_, fn(v) { assets.add(v, "", "", -1) })),
  )
}

test r14_skim_asset() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(
          with_value(_, fn(v) { assets.add(v, usdm_policy, usdm_name, -1) }),
        ),
  )
}

test r14_extra_asset_left_in_vault() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(
          with_value(_, fn(v) { assets.add(v, usdm_policy, usdm_name, 1) }),
        ),
  )
}

test r14_junk_token_added() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_vault_output(
          with_value(_, fn(v) { assets.add(v, attacker, "junk", 1) }),
        ),
  )
}

test r14_thread_token_removed() {
  let c = release_case(release_base)
  !release(c, release_tx(c) |> edit_vault_output(drop_thread))
}

// ## R15: treasury floor

test r15_lands_exactly_on_floor() {
  settles(ReleaseCase { ..release_case(release_base), balance: 108_420_000 })
}

test r15_below_floor() {
  !settles(ReleaseCase { ..release_case(release_base), balance: 108_419_999 })
}

// ## R16: recipient receives the amount

test r16_recipient_swapped() {
  !settles(
    ReleaseCase { ..release_case(release_base), pay_to: key_address(attacker) },
  )
}

test r16_recipient_short_paid() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_output(
          recipient_ix,
          with_value(_, fn(v) { assets.add(v, usdm_policy, usdm_name, -1) }),
        ),
  )
}

test r16_recipient_without_digest() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_output(recipient_ix, fn(o) { Output { ..o, datum: NoDatum } }),
  )
}

test r16_recipient_digest_by_hash() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_output(
          recipient_ix,
          fn(o) {
            Output { ..o, datum: DatumHash(message.digest(c.signed.auth)) }
          },
        ),
  )
}

test r16_payment_claimed_by_other_vault() {
  // Same recipient and amount, but the output is tagged for another vault's
  // authorization: one output cannot settle two releases.
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_output(
          recipient_ix,
          fn(o) {
            Output {
              ..o,
              datum: InlineDatum(message.digest(release_other_vault.auth)),
            }
          },
        ),
  )
}

test r16_recipient_stake_mismatch() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      pay_to: address.with_delegation_key(key_address(aws), attacker),
    },
  )
}

test r16_recipient_script_instead_of_key() {
  !settles(
    ReleaseCase {
      ..release_case(release_base),
      pay_to: address.from_script(aws),
    },
  )
}

test r16_recipient_is_the_vault() fail {
  // R13 blocks paying the vault itself: a second vault output halts `expect [out]`.
  let c = ReleaseCase {
    ..release_case(release_to_vault),
    pay_to: vault_address(),
  }
  release(c, release_tx(c))
}

test r16_recipient_reference_script() {
  let c = release_case(release_base)
  !release(
    c,
    release_tx(c)
      |> edit_output(
          recipient_ix,
          fn(o) { Output { ..o, reference_script: Some(attacker) } },
        ),
  )
}

// ## R16 across vaults: one payment output cannot settle two releases

/// Stands in for a second vault script: the validator takes its own hash from
/// the spent input, so the same code runs as vault B at this address.
const other_vault_hash: ByteArray =
  #"abababababababababababababababababababababababababababab"

const other_vault_utxo: OutputReference =
  OutputReference {
    transaction_id: #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
    output_index: 0,
  }

fn other_vault_output(d: VaultDatum, balance: Int) -> Output {
  Output {
    address: address.from_script(other_vault_hash),
    value: assets.from_lovelace(5_000_000)
      |> assets.add(usdm_policy, usdm_name, balance)
      |> assets.add(other_vault_hash, vault_token_name, 1),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

/// Vault A (release_base) and vault B (release_other_vault) each release 8.42
/// USDM to the same vendor in one transaction. With `own_payment`, B gets its
/// own digest-tagged output; without it, only A's payment exists.
fn two_vault_tx(own_payment: Bool) -> Transaction {
  let tx = release_tx(release_case(release_base))
  let b_next = VaultDatum {
    last_nonce: 1,
    day_index: today,
    spent_today: 8_420_000,
  }
  let b_payment = Output {
    address: key_address(aws),
    value: assets.merge(
      assets.from_lovelace(2_000_000),
      testkit.usdm(8_420_000),
    ),
    datum: InlineDatum(message.digest(release_other_vault.auth)),
    reference_script: None,
  }
  let extra = if own_payment {
    [b_payment]
  } else {
    []
  }
  Transaction {
    ..tx,
    inputs: [
      Input {
        output_reference: other_vault_utxo,
        output: other_vault_output(testkit.fresh, start_balance),
      },
      ..tx.inputs
    ],
    outputs: list.concat(
      tx.outputs,
      [other_vault_output(b_next, start_balance - 8_420_000), ..extra],
    ),
  }
}

fn release_vault_b(tx: Transaction) -> Bool {
  let raw: Data = testkit.fresh
  vault.vault.spend(
    anchor_ref,
    chain_tag,
    vault_seed,
    Some(raw),
    Release {
      auth: release_other_vault.auth,
      signature: release_other_vault.signature,
    },
    other_vault_utxo,
    tx,
  )
}

test r16_two_vaults_share_one_payment() {
  // The vendor output settles vault A, so vault B cannot also claim it.
  let tx = two_vault_tx(False)
  genuine(release_other_vault) && release(release_case(release_base), tx) && !release_vault_b(
    tx,
  )
}

test r16_two_vaults_each_pay_their_own_output() {
  let tx = two_vault_tx(True)
  release(release_case(release_base), tx) && release_vault_b(tx)
}

// ## Deposit

test deposit_tops_up() {
  spend(testkit.fresh, Deposit, deposit_tx())
}

test deposit_changes_datum() {
  !spend(
    testkit.fresh,
    Deposit,
    deposit_tx()
      |> edit_output(
          0,
          fn(o) {
            Output {
              ..o,
              datum: InlineDatum(
                VaultDatum { last_nonce: 99, day_index: 0, spent_today: 0 },
              ),
            }
          },
        ),
  )
}

test deposit_withdraws_asset() {
  !spend(
    testkit.fresh,
    Deposit,
    deposit_tx()
      |> edit_output(
          0,
          with_value(_, fn(v) {
            assets.add(v, usdm_policy, usdm_name, -20_000_000)
          }),
        ),
  )
}

test deposit_withdraws_lovelace() {
  !spend(
    testkit.fresh,
    Deposit,
    deposit_tx()
      |> edit_output(
          0,
          with_value(_, fn(v) { assets.add(v, "", "", -1_000_001) }),
        ),
  )
}

test deposit_adds_junk_token() {
  !spend(
    testkit.fresh,
    Deposit,
    deposit_tx()
      |> edit_output(
          0,
          with_value(_, fn(v) { assets.add(v, attacker, "junk", 1) }),
        ),
  )
}

test deposit_changes_stake_credential() {
  !spend(
    testkit.fresh,
    Deposit,
    deposit_tx()
      |> edit_output(
          0,
          fn(o) {
            Output {
              ..o,
              address: address.with_delegation_key(vault_address(), attacker),
            }
          },
        ),
  )
}

test deposit_attaches_reference_script() {
  !spend(
    testkit.fresh,
    Deposit,
    deposit_tx()
      |> edit_output(
          0,
          fn(o) { Output { ..o, reference_script: Some(attacker) } },
        ),
  )
}

test deposit_moves_thread_token() {
  !spend(testkit.fresh, Deposit, deposit_tx() |> edit_output(0, drop_thread))
}

test r1_deposit_second_vault_input() {
  let tx = deposit_tx()
  let junk = Input {
    output_reference: testkit.fee_utxo,
    output: Output {
      address: vault_address(),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
  !spend(
    testkit.fresh,
    Deposit,
    Transaction { ..tx, inputs: [junk, ..tx.inputs] },
  )
}

// ## W1: PrincipalWithdraw

test w1_cfo_withdraws() {
  spend(testkit.fresh, PrincipalWithdraw, withdraw_tx([cfo]))
}

test w1_without_cfo() {
  !spend(testkit.fresh, PrincipalWithdraw, withdraw_tx([]))
}

test w1_intruder_signs() {
  !spend(testkit.fresh, PrincipalWithdraw, withdraw_tx([intruder]))
}

test w1_cfo_recovers_datumless_utxo() {
  let tx = withdraw_tx([cfo])
  vault.vault.spend(
    anchor_ref,
    chain_tag,
    vault_seed,
    None,
    PrincipalWithdraw,
    vault_utxo,
    tx,
  )
}

// ## V1-V3: one-shot VAULT token

fn mint_vault(tx: Transaction) -> Bool {
  vault.vault.mint(anchor_ref, chain_tag, vault_seed, Void, vault_hash, tx)
}

test v_creates_vault() {
  mint_vault(vault_mint_tx())
}

test v1_seed_not_spent() {
  !mint_vault(Transaction { ..vault_mint_tx(), inputs: [fee_input()] })
}

test v2_two_tokens() {
  let tx = vault_mint_tx()
  !mint_vault(
    Transaction {
      ..tx,
      mint: assets.from_asset(vault_hash, vault_token_name, 2),
      outputs: [
        Output {
          ..vault_output(testkit.fresh, start_balance),
          value: testkit.vault_value(start_balance)
            |> assets.add(vault_hash, vault_token_name, 1),
        },
      ],
    },
  )
}

test v2_extra_token_name() fail {
  let tx = vault_mint_tx()
  mint_vault(
    Transaction { ..tx, mint: assets.add(tx.mint, vault_hash, "VAULT2", 1) },
  )
}

test v2_token_to_key_address() {
  let tx = vault_mint_tx()
  !mint_vault(
    Transaction {
      ..tx,
      outputs: [
        Output {
          ..vault_output(testkit.fresh, start_balance),
          address: key_address(attacker),
        },
      ],
    },
  )
}

test v2_preloaded_datum() {
  let tx = vault_mint_tx()
  !mint_vault(
    Transaction {
      ..tx,
      outputs: [
        vault_output(
          VaultDatum {
            last_nonce: 0,
            day_index: 0,
            spent_today: -1_000_000_000,
          },
          start_balance,
        ),
      ],
    },
  )
}

test v2_burn_keeping_vault_output() {
  let tx = vault_mint_tx()
  !mint_vault(
    Transaction {
      ..tx,
      mint: assets.from_asset(vault_hash, vault_token_name, -1),
    },
  )
}

test v2_burn_rejected() fail {
  let tx = vault_mint_tx()
  mint_vault(
    Transaction {
      ..tx,
      mint: assets.from_asset(vault_hash, vault_token_name, -1),
      outputs: [],
    },
  )
}

test v3_without_principal() {
  !mint_vault(Transaction { ..vault_mint_tx(), extra_signatories: [intruder] })
}

test v3_without_anchor() fail {
  mint_vault(Transaction { ..vault_mint_tx(), reference_inputs: [] })
}
