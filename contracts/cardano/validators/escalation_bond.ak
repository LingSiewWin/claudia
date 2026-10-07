use aiken/collection/list
use aiken/interval.{Finite}
use authority/types.{BondDatum, BondRedeemer, Capture, Refund}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{AssetName, Assets, PolicyId}
use cardano/transaction.{OutputReference, Transaction}

/// Escalation bond escrow. One script per network (`chain_tag`), the sink is a
/// parameter. The bond can only ever go back to the agent (Refund) or into the
/// sink (Capture); no third address, the approver included, can receive it.
validator escalation_bond(sink_hash: ByteArray, chain_tag: Int) {
  spend(
    datum: Option<BondDatum>,
    redeemer: BondRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    expect Some(own) = transaction.find_input(self.inputs, own_ref)
    expect Script(own_hash) = own.output.address.payment_credential
    let (policy, name) = bond_asset(own.output.value)
    let pays = fn(to: fn(Address) -> Bool) {
      list.any(
        self.outputs,
        fn(o) {
          to(o.address) && assets.quantity_of(o.value, policy, name) >= d.amount
        },
      )
    }
    let approved = list.has(self.extra_signatories, d.approver_pkh)
    // One escrow input per tx: a single payout can never settle two bonds.
    let b0 = list.count(
      self.inputs,
      fn(i) { i.output.address.payment_credential == Script(own_hash) },
    ) == 1
    // `chain_tag` only separates the preprod and mainnet script hashes; the
    // ledger already pins the network, so the check itself is trivial.
    let b1 = chain_tag >= 0
    when redeemer is {
      Refund -> {
        let unlocked = when self.validity_range.lower_bound.bound_type is {
          Finite(lower) -> lower > d.locked_until
          _ -> False
        }
        let agent = agent_address(d)
        let b2 = approved || unlocked
        let b3 = pays(fn(a) { a == agent })
        and {
          b0?,
          b1?,
          b2?,
          b3?,
        }
      }
      Capture -> {
        let b4 = approved
        let b5 = pays(fn(a) { a.payment_credential == Script(sink_hash) })
        and {
          b0?,
          b1?,
          b4?,
          b5?,
        }
      }
    }
  }

  else(_) {
    fail
  }
}

/// The bond asset is whatever the escrow UTxO holds besides its ADA: a single
/// native token, or lovelace when there is none.
fn bond_asset(v: Assets) -> (PolicyId, AssetName) {
  when assets.flatten(assets.without_lovelace(v)) is {
    [] -> (assets.ada_policy_id, assets.ada_asset_name)
    [(policy, name, _)] -> (policy, name)
    _ -> fail @"escrow UTxO holds more than one token"
  }
}

fn agent_address(d: BondDatum) -> Address {
  Address {
    payment_credential: VerificationKey(d.agent_pkh),
    stake_credential: when d.agent_stake is {
      Some(stake) -> Some(Inline(VerificationKey(stake)))
      None -> None
    },
  }
}
