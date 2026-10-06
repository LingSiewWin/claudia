//// Test world for the validator tests: the M-001 anchor (limits 10 / 50 /
//// 50 / 100 USDM), a 135 USDM vault, and the transactions an honest
//// executor or principal would build. Tests mutate these to attack them.

use aiken/collection/list
use aiken/interval
use authority/fixtures.{Signed}
use authority/message
use authority/types.{
  Active, AnchorDatum, VaultDatum, anchor_token_name, day_ms, vault_token_name,
}
use cardano/address.{Address}
use cardano/assets.{Assets}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}

pub const vault_hash: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

pub const anchor_ref: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

pub const chain_tag: Int = 0

pub const usdm_policy: ByteArray =
  #"16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde"

pub const usdm_name: ByteArray = #"0014df10745553444d"

/// The principal admin key (mandate admin, W1, V3, Update, Revoke).
pub const cfo: ByteArray =
  #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

/// The payment approver key: it only co-signs flagged releases (R11).
pub const approver: ByteArray =
  #"a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"

pub const intruder: ByteArray =
  #"99999999999999999999999999999999999999999999999999999999"

pub const aws: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

pub const attacker: ByteArray =
  #"66666666666666666666666666666666666666666666666666666666"

pub const fee_payer: ByteArray =
  #"fefefefefefefefefefefefefefefefefefefefefefefefefefefefe"

pub const anchor_seed: OutputReference =
  OutputReference {
    transaction_id: #"a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5",
    output_index: 0,
  }

pub const vault_seed: OutputReference =
  OutputReference {
    transaction_id: #"b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5",
    output_index: 1,
  }

pub const anchor_utxo: OutputReference =
  OutputReference {
    transaction_id: #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    output_index: 0,
  }

pub const vault_utxo: OutputReference =
  OutputReference {
    transaction_id: #"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
    output_index: 0,
  }

pub const fee_utxo: OutputReference =
  OutputReference {
    transaction_id: #"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1",
    output_index: 2,
  }

pub const mandate: AnchorDatum =
  AnchorDatum {
    mandate_hash: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    version: 3,
    status: Active,
    engine_vkey: fixtures.engine_vkey,
    principal_pkh: cfo,
    approver_pkh: approver,
    asset_policy: usdm_policy,
    asset_name: usdm_name,
    autonomous_limit: 10_000_000,
    hard_cap: 50_000_000,
    daily_cap: 50_000_000,
    treasury_minimum: 100_000_000,
    valid_until: 1_900_000_000_000,
  }

pub const fresh: VaultDatum =
  VaultDatum { last_nonce: 0, day_index: 0, spent_today: 0 }

pub const start_balance: Int = 135_000_000

/// Validity lower bound used by default: 2027-01-15, UTC day 20833.
pub const lower: Int = 1_799_999_500_000

pub const upper: Int = 1_799_999_800_000

pub const today: Int = 20833

pub fn usdm(quantity: Int) -> Assets {
  assets.from_asset(usdm_policy, usdm_name, quantity)
}

pub fn key_address(pkh: ByteArray) -> Address {
  address.from_verification_key(pkh)
}

pub fn vault_address() -> Address {
  address.from_script(vault_hash)
}

pub fn vault_value(balance: Int) -> Assets {
  assets.from_lovelace(5_000_000)
    |> assets.add(usdm_policy, usdm_name, balance)
    |> assets.add(vault_hash, vault_token_name, 1)
}

pub fn vault_output(d: VaultDatum, balance: Int) -> Output {
  Output {
    address: vault_address(),
    value: vault_value(balance),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

pub fn vault_input(d: VaultDatum, balance: Int) -> Input {
  Input { output_reference: vault_utxo, output: vault_output(d, balance) }
}

pub fn anchor_output(d: AnchorDatum) -> Output {
  Output {
    address: address.from_script(anchor_ref),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(anchor_ref, anchor_token_name, 1),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

pub fn anchor_input(d: AnchorDatum) -> Input {
  Input { output_reference: anchor_utxo, output: anchor_output(d) }
}

pub fn wallet_output(pkh: ByteArray, value: Assets) -> Output {
  Output {
    address: key_address(pkh),
    value,
    datum: NoDatum,
    reference_script: None,
  }
}

pub fn fee_input() -> Input {
  Input {
    output_reference: fee_utxo,
    output: wallet_output(fee_payer, assets.from_lovelace(50_000_000)),
  }
}

pub fn edit_output(
  tx: Transaction,
  index: Int,
  f: fn(Output) -> Output,
) -> Transaction {
  Transaction {
    ..tx,
    outputs: list.indexed_map(
      tx.outputs,
      fn(i, o) {
        if i == index {
          f(o)
        } else {
          o
        }
      },
    ),
  }
}

// ## Release

pub type ReleaseCase {
  anchor: AnchorDatum,
  datum: VaultDatum,
  balance: Int,
  signed: Signed,
  pay_to: Address,
  lower: Int,
  upper: Int,
  signers: List<ByteArray>,
}

pub const recipient_ix: Int = 0

pub const vault_ix: Int = 1

pub fn release_case(signed: Signed) -> ReleaseCase {
  ReleaseCase {
    anchor: mandate,
    datum: fresh,
    balance: start_balance,
    signed,
    pay_to: key_address(aws),
    lower,
    upper,
    signers: [],
  }
}

/// The release an honest executor builds for `c`: recipient output tagged
/// with the authorization digest, vault continuing output, fee-wallet change.
pub fn release_tx(c: ReleaseCase) -> Transaction {
  let amount = c.signed.auth.amount
  let day = c.lower / day_ms
  let spent = if day > c.datum.day_index {
    amount
  } else {
    c.datum.spent_today + amount
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [vault_input(c.datum, c.balance), fee_input()],
    reference_inputs: [anchor_input(c.anchor)],
    outputs: [
      Output {
        address: c.pay_to,
        value: assets.merge(assets.from_lovelace(2_000_000), usdm(amount)),
        datum: InlineDatum(message.digest(c.signed.auth)),
        reference_script: None,
      },
      vault_output(
        VaultDatum {
          last_nonce: c.signed.auth.nonce,
          day_index: day,
          spent_today: spent,
        },
        c.balance - amount,
      ),
      wallet_output(fee_payer, assets.from_lovelace(47_000_000)),
    ],
    validity_range: interval.between(c.lower, c.upper),
    extra_signatories: c.signers,
  }
}

// ## Deposit and PrincipalWithdraw

/// Anyone tops the vault up by 10 USDM and 1 ADA.
pub fn deposit_tx() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [vault_input(fresh, start_balance), fee_input()],
    reference_inputs: [anchor_input(mandate)],
    outputs: [
      Output {
        ..vault_output(fresh, start_balance + 10_000_000),
        value: vault_value(start_balance + 10_000_000)
          |> assets.add("", "", 1_000_000),
      },
      wallet_output(fee_payer, assets.from_lovelace(47_000_000)),
    ],
  }
}

/// The principal empties the vault to their own wallet.
pub fn withdraw_tx(signers: List<ByteArray>) -> Transaction {
  withdraw_to_tx(cfo, signers)
}

/// The whole vault leaves to `pkh`'s wallet.
pub fn withdraw_to_tx(pkh: ByteArray, signers: List<ByteArray>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [vault_input(fresh, start_balance), fee_input()],
    reference_inputs: [anchor_input(mandate)],
    outputs: [wallet_output(pkh, vault_value(start_balance))],
    extra_signatories: signers,
  }
}

// ## Creation

/// The principal creates the vault: spends the seed, mints VAULT, funds it.
pub fn vault_mint_tx() -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: vault_seed,
        output: wallet_output(cfo, assets.from_lovelace(20_000_000)),
      },
    ],
    reference_inputs: [anchor_input(mandate)],
    outputs: [vault_output(fresh, start_balance)],
    mint: assets.from_asset(vault_hash, vault_token_name, 1),
    extra_signatories: [cfo],
  }
}

/// The principal creates the anchor: spends the seed, mints MANDATE.
pub fn anchor_mint_tx(d: AnchorDatum) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: anchor_seed,
        output: wallet_output(cfo, assets.from_lovelace(20_000_000)),
      },
    ],
    outputs: [anchor_output(d)],
    mint: assets.from_asset(anchor_ref, anchor_token_name, 1),
    extra_signatories: [cfo],
  }
}

/// The principal moves the anchor UTxO from `old` to `next`.
pub fn anchor_spend_tx(old: AnchorDatum, next: AnchorDatum) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [anchor_input(old), fee_input()],
    outputs: [
      anchor_output(next),
      wallet_output(fee_payer, assets.from_lovelace(48_000_000)),
    ],
    extra_signatories: [cfo],
  }
}
