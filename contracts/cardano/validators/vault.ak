use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{verify_ed25519_signature}
use aiken/interval.{Finite, Interval, IntervalBound}
use authority/anchor
use authority/message
use authority/types.{
  Active, AnchorDatum, Authorization, Deposit, PrincipalWithdraw, Release,
  VaultDatum, VaultRedeemer, day_ms, max_window_ms, vault_token_name,
}
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}

/// One vault per (treasury, mandate). Mint and spend share one script, so
/// the VAULT thread-token policy id is the vault script hash.
validator vault(anchor_ref: ByteArray, chain_tag: Int, seed: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    let a = anchor.read(self.reference_inputs, anchor_ref)
    expect [Pair(name, quantity)] = dict.to_pairs(
      assets.tokens(self.mint, policy_id),
    )
    expect [out] = list.filter(
      self.outputs,
      fn(o) { assets.quantity_of(o.value, policy_id, vault_token_name) > 0 },
    )
    let zero = VaultDatum { last_nonce: 0, day_index: 0, spent_today: 0 }
    let v1 = list.any(self.inputs, fn(i) { i.output_reference == seed })
    let v2 = and {
      name == vault_token_name,
      quantity == 1,
      out.address.payment_credential == Script(policy_id),
      out.datum == InlineDatum(zero),
    }
    let v3 = list.has(self.extra_signatories, a.principal_pkh)
    and {
      v1?,
      v2?,
      v3?,
    }
  }

  spend(
    datum: Option<Data>,
    redeemer: VaultRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(own) = transaction.find_input(self.inputs, own_ref)
    expect Script(own_hash) = own.output.address.payment_credential
    let a = anchor.read(self.reference_inputs, anchor_ref)
    when redeemer is {
      PrincipalWithdraw -> {
        let w1 = list.has(self.extra_signatories, a.principal_pkh)
        w1?
      }
      Deposit -> deposit(self, own, own_hash, a)
      Release { auth, signature } -> {
        expect Some(raw) = datum
        expect d: VaultDatum = raw
        release(
          self,
          own,
          own_hash,
          d,
          a,
          anchor_ref,
          chain_tag,
          auth,
          signature,
        )
      }
    }
  }

  else(_) {
    fail
  }
}

/// R7 precondition: both validity bounds are finite (POSIX milliseconds).
fn finite_bounds(range: Interval) -> (Int, Int) {
  when range is {
    Interval {
      lower_bound: IntervalBound { bound_type: Finite(lower), .. },
      upper_bound: IntervalBound { bound_type: Finite(upper), .. },
    } -> (lower, upper)
    _ -> fail @"validity range must be bounded"
  }
}

fn vault_inputs(self: Transaction, own_hash: ByteArray) -> Int {
  list.count(
    self.inputs,
    fn(i) { i.output.address.payment_credential == Script(own_hash) },
  )
}

fn thread_token(own: Input, own_hash: ByteArray) -> Bool {
  assets.quantity_of(own.output.value, own_hash, vault_token_name) == 1
}

fn deposit(
  self: Transaction,
  own: Input,
  own_hash: ByteArray,
  a: AnchorDatum,
) -> Bool {
  expect [out] = list.filter(
    self.outputs,
    fn(o) { o.address.payment_credential == Script(own_hash) },
  )
  let before = own.output.value
  let quantity = fn(v) { assets.quantity_of(v, a.asset_policy, a.asset_name) }
  let added = quantity(out.value) - quantity(before)
  let r0 = thread_token(own, own_hash)
  let r1 = vault_inputs(self, own_hash) == 1
  let deposit_state = and {
    out.address == own.output.address,
    out.datum == own.output.datum,
    out.reference_script == None,
  }
  let deposit_value = and {
    added >= 0,
    assets.lovelace_of(out.value) >= assets.lovelace_of(before),
    assets.without_lovelace(out.value) == assets.add(
      assets.without_lovelace(before),
      a.asset_policy,
      a.asset_name,
      added,
    ),
  }
  and {
    r0?,
    r1?,
    deposit_state?,
    deposit_value?,
  }
}

fn release(
  self: Transaction,
  own: Input,
  own_hash: ByteArray,
  d: VaultDatum,
  a: AnchorDatum,
  anchor_ref: ByteArray,
  chain_tag: Int,
  auth: Authorization,
  signature: ByteArray,
) -> Bool {
  let (lower, upper) = finite_bounds(self.validity_range)
  expect [out] = list.filter(
    self.outputs,
    fn(o) { o.address.payment_credential == Script(own_hash) },
  )
  let before = own.output.value
  let day = lower / day_ms
  let new_spent = if day > d.day_index {
    auth.amount
  } else {
    d.spent_today + auth.amount
  }
  let next = VaultDatum {
    last_nonce: auth.nonce,
    day_index: day,
    spent_today: new_spent,
  }
  let recipient = message.recipient_address(auth)
  let digest = message.digest(auth)
  let r0 = thread_token(own, own_hash)
  let r1 = vault_inputs(self, own_hash) == 1
  let r3 = a.status == Active
  let r4 = and {
    auth.mandate_ref == anchor_ref,
    auth.mandate_hash == a.mandate_hash,
    auth.mandate_version == a.version,
  }
  let r5 = auth.chain_tag == chain_tag && auth.vault_hash == own_hash
  let r6 = verify_ed25519_signature(a.engine_vkey, digest, signature)
  let r7 = and {
    upper <= auth.valid_until,
    upper <= a.valid_until,
    upper - lower <= max_window_ms,
  }
  let r8 = auth.nonce > d.last_nonce
  let r9 = and {
    auth.action_type == 1,
    auth.amount > 0,
    auth.asset_policy == a.asset_policy,
    auth.asset_name == a.asset_name,
  }
  let r10 = auth.amount <= a.hard_cap
  // Above the autonomous limit the engine must have flagged it, and every
  // flagged authorization needs the payment approver's co-signature (the
  // message field keeps its `requires_principal` name).
  let r11 = if auth.requires_principal == 1 {
    list.has(self.extra_signatories, a.approver_pkh)
  } else {
    auth.amount <= a.autonomous_limit
  }
  let r12 = day >= d.day_index && new_spent <= a.daily_cap
  let r13 = and {
    out.address == own.output.address,
    out.datum == InlineDatum(next),
    out.reference_script == None,
  }
  let r14 = and {
    assets.lovelace_of(out.value) >= assets.lovelace_of(before),
    assets.without_lovelace(out.value) == assets.add(
      assets.without_lovelace(before),
      a.asset_policy,
      a.asset_name,
      -auth.amount,
    ),
  }
  let r15 = assets.quantity_of(out.value, a.asset_policy, a.asset_name) >= a.treasury_minimum
  // The digest datum ties the payment to this one authorization, so a
  // single output cannot satisfy two releases in the same transaction.
  let r16 = and {
    // Backstop: R13 already allows only one output at the vault credential.
    recipient.payment_credential != Script(own_hash),
    list.any(
      self.outputs,
      fn(o) {
        and {
          o.address == recipient,
          o.datum == InlineDatum(digest),
          o.reference_script == None,
          assets.quantity_of(o.value, a.asset_policy, a.asset_name) >= auth.amount,
        }
      },
    ),
  }
  and {
    r0?,
    r1?,
    r3?,
    r4?,
    r5?,
    r6?,
    r7?,
    r8?,
    r9?,
    r10?,
    r11?,
    r12?,
    r13?,
    r14?,
    r15?,
    r16?,
  }
}
