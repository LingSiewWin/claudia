use aiken/collection/dict
use aiken/collection/list
use authority/anchor
use authority/types.{
  Active, AnchorDatum, AnchorRedeemer, Revoke, Revoked, Update,
  anchor_token_name,
}
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}

/// One anchor per mandate. Mint and spend share one script, so the NFT
/// policy id, the script hash and `mandate_ref` are the same 28 bytes.
validator mandate_anchor(seed: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    expect [Pair(name, quantity)] = dict.to_pairs(
      assets.tokens(self.mint, policy_id),
    )
    expect [out] = list.filter(
      self.outputs,
      fn(o) { assets.quantity_of(o.value, policy_id, anchor_token_name) > 0 },
    )
    expect InlineDatum(data) = out.datum
    expect d: AnchorDatum = data
    let m1 = list.any(self.inputs, fn(i) { i.output_reference == seed })
    let m2 = name == anchor_token_name && quantity == 1
    let m3 = and {
      out.address.payment_credential == Script(policy_id),
      d.status == Active,
    }
    let m4 = anchor.valid_datum(d)
    let m5 = list.has(self.extra_signatories, d.principal_pkh)
    and {
      m1?,
      m2?,
      m3?,
      m4?,
      m5?,
    }
  }

  spend(
    datum: Option<AnchorDatum>,
    redeemer: AnchorRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(old) = datum
    expect Some(own) = transaction.find_input(self.inputs, own_ref)
    expect Script(own_hash) = own.output.address.payment_credential
    expect [out] = list.filter(
      self.outputs,
      fn(o) { assets.quantity_of(o.value, own_hash, anchor_token_name) > 0 },
    )
    let holds_nft = assets.quantity_of(
      own.output.value,
      own_hash,
      anchor_token_name,
    ) == 1
    let signed_by = fn(pkh) { list.has(self.extra_signatories, pkh) }
    let continues_as = fn(next: AnchorDatum) {
      and {
        out.address == own.output.address,
        out.datum == InlineDatum(next),
      }
    }
    when redeemer is {
      Update { new } -> {
        let update_nft = holds_nft
        let update_signed = signed_by(old.principal_pkh)
        // A new principal proves it holds its key, as at creation (M5).
        let update_handover = new.principal_pkh == old.principal_pkh || signed_by(
          new.principal_pkh,
        )
        let update_continuing = continues_as(new)
        let update_rule = new.version > old.version && anchor.valid_datum(new)
        and {
          update_nft?,
          update_signed?,
          update_handover?,
          update_continuing?,
          update_rule?,
        }
      }
      Revoke -> {
        let revoke_nft = holds_nft
        let revoke_signed = signed_by(old.principal_pkh)
        let revoke_continuing = continues_as(
          AnchorDatum { ..old, status: Revoked, version: old.version + 1 },
        )
        and {
          revoke_nft?,
          revoke_signed?,
          revoke_continuing?,
        }
      }
    }
  }

  else(_) {
    fail
  }
}
