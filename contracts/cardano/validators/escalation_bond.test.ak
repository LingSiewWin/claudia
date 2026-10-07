use aiken/interval
use authority/testkit.{
  approver, attacker, edit_output, fee_input, fee_payer, intruder, key_address,
  usdm, wallet_output,
}
use authority/types.{BondDatum, BondRedeemer, Capture, Refund}
use cardano/address
use cardano/assets.{Assets}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use escalation_bond

// ## World: a 5 ADA bond locked by an agent with a staked wallet

const sink_hash: ByteArray =
  #"5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"

const escrow_hash: ByteArray =
  #"e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"

const agent: ByteArray =
  #"adadadadadadadadadadadadadadadadadadadadadadadadadadadad"

const agent_stake: ByteArray =
  #"aeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeae"

const chain_tag: Int = 0

const amount: Int = 5_000_000

const locked_until: Int = 1_800_000_000_000

const bond_utxo: OutputReference =
  OutputReference {
    transaction_id: #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
    output_index: 0,
  }

const other_bond_utxo: OutputReference =
  OutputReference {
    transaction_id: #"d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2",
    output_index: 0,
  }

const bond: BondDatum =
  BondDatum {
    approval_ref: #"0101010101010101010101010101010101010101010101010101010101010101",
    action_hash: #"0202020202020202020202020202020202020202020202020202020202020202",
    mandate_ref: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    agent_pkh: agent,
    agent_stake: Some(agent_stake),
    approver_pkh: approver,
    amount,
    locked_until,
  }

fn agent_address() -> address.Address {
  key_address(agent) |> address.with_delegation_key(agent_stake)
}

fn sink_address() -> address.Address {
  address.from_script(sink_hash)
}

fn escrow_input(d: BondDatum, value: Assets) -> Input {
  Input {
    output_reference: bond_utxo,
    output: Output {
      address: address.from_script(escrow_hash),
      value,
      datum: InlineDatum(d),
      reference_script: None,
    },
  }
}

fn payout(to: address.Address, value: Assets) -> Output {
  Output { address: to, value, datum: NoDatum, reference_script: None }
}

/// The honest spend: the fee wallet pays, the bond goes to `to`.
fn spend_tx(to: address.Address, signers: List<ByteArray>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [escrow_input(bond, assets.from_lovelace(amount)), fee_input()],
    outputs: [
      payout(to, assets.from_lovelace(amount)),
      wallet_output(fee_payer, assets.from_lovelace(49_000_000)),
    ],
    extra_signatories: signers,
  }
}

fn after_lock(tx: Transaction) -> Transaction {
  Transaction {
    ..tx,
    validity_range: interval.between(locked_until + 1, locked_until + 600_000),
  }
}

fn spend(d: BondDatum, redeemer: BondRedeemer, tx: Transaction) -> Bool {
  escalation_bond.escalation_bond.spend(
    sink_hash,
    chain_tag,
    Some(d),
    redeemer,
    bond_utxo,
    tx,
  )
}

// ## Refund

test refund_by_approver_signature() {
  spend(bond, Refund, spend_tx(agent_address(), [approver]))
}

test refund_after_locked_until_without_signature() {
  spend(bond, Refund, spend_tx(agent_address(), []) |> after_lock)
}

test refund_before_locked_until_without_signature_fails() {
  let tx = Transaction {
    ..spend_tx(agent_address(), []),
    validity_range: interval.between(locked_until - 600_000, locked_until),
  }
  !spend(bond, Refund, tx)
}

test refund_with_unbounded_validity_and_no_signature_fails() {
  !spend(bond, Refund, spend_tx(agent_address(), []))
}

test refund_paying_less_than_amount_fails() {
  let tx = spend_tx(agent_address(), [approver])
    |> edit_output(
        0,
        fn(o) { Output { ..o, value: assets.from_lovelace(amount - 1) } },
      )
  !spend(bond, Refund, tx)
}

test refund_paying_someone_other_than_the_agent_fails() {
  !spend(bond, Refund, spend_tx(key_address(intruder), [approver]))
}

test refund_to_agent_key_with_wrong_stake_fails() {
  let wrong = key_address(agent) |> address.with_delegation_key(intruder)
  !spend(bond, Refund, spend_tx(wrong, [approver]))
}

test refund_paying_the_approver_fails() {
  !spend(bond, Refund, spend_tx(key_address(approver), [approver]))
}

test refund_to_an_unstaked_agent() {
  let unstaked = BondDatum { ..bond, agent_stake: None }
  let tx = Transaction {
    ..spend_tx(key_address(agent), [approver]),
    inputs: [escrow_input(unstaked, assets.from_lovelace(amount)), fee_input()],
  }
  spend(unstaked, Refund, tx)
}

test refund_of_a_token_bond_pays_the_token() {
  let tx = Transaction {
    ..spend_tx(agent_address(), [approver]),
    inputs: [
      escrow_input(
        bond,
        assets.merge(assets.from_lovelace(2_000_000), usdm(amount)),
      ),
      fee_input(),
    ],
  }
  // ADA alone no longer satisfies a USDM bond...
  let ada_only = spend(bond, Refund, tx)
  // ...the token does.
  let with_token = spend(
    bond,
    Refund,
    tx
      |> edit_output(
          0,
          fn(o) {
            Output {
              ..o,
              value: assets.merge(assets.from_lovelace(2_000_000), usdm(amount)),
            }
          },
        ),
  )
  !ada_only && with_token
}

// ## Capture

test capture_by_approver_to_sink() {
  spend(bond, Capture, spend_tx(sink_address(), [approver]))
}

test capture_without_approver_fails() {
  !spend(bond, Capture, spend_tx(sink_address(), []))
}

test capture_after_locked_until_without_approver_fails() {
  !spend(bond, Capture, spend_tx(sink_address(), []) |> after_lock)
}

test capture_to_non_sink_fails() {
  !spend(bond, Capture, spend_tx(address.from_script(attacker), [approver]))
}

test capture_to_agent_fails() {
  !spend(bond, Capture, spend_tx(agent_address(), [approver]))
}

test capture_paying_the_approver_fails() {
  !spend(bond, Capture, spend_tx(key_address(approver), [approver]))
}

test capture_paying_less_than_amount_fails() {
  let tx = spend_tx(sink_address(), [approver])
    |> edit_output(
        0,
        fn(o) { Output { ..o, value: assets.from_lovelace(amount - 1) } },
      )
  !spend(bond, Capture, tx)
}

// ## One bond per transaction

test two_bonds_cannot_share_one_payout() {
  let second = Input {
    ..escrow_input(bond, assets.from_lovelace(amount)),
    output_reference: other_bond_utxo,
  }
  let tx = spend_tx(agent_address(), [approver])
  !spend(bond, Refund, Transaction { ..tx, inputs: [second, ..tx.inputs] })
}

test datum_missing_fails() fail {
  escalation_bond.escalation_bond.spend(
    sink_hash,
    chain_tag,
    None,
    Refund,
    bond_utxo,
    spend_tx(agent_address(), [approver]),
  )
}
