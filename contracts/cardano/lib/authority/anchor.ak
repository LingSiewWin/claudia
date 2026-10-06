use aiken/collection/list
use aiken/primitive/bytearray
use authority/types.{AnchorDatum, anchor_token_name}
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{InlineDatum, Input}

/// M4: limits are ordered and every key, hash and name has its exact length.
pub fn valid_datum(d: AnchorDatum) -> Bool {
  and {
    d.version >= 1,
    d.autonomous_limit > 0,
    d.hard_cap >= d.autonomous_limit,
    d.daily_cap >= d.autonomous_limit,
    d.treasury_minimum >= 0,
    bytearray.length(d.mandate_hash) == 32,
    bytearray.length(d.engine_vkey) == 32,
    bytearray.length(d.principal_pkh) == 28,
    bytearray.length(d.asset_policy) == 28,
    bytearray.length(d.asset_name) <= 32,
  }
}

/// R2: exactly one reference input holds the anchor NFT, it sits at the
/// anchor script address, and it carries an inline AnchorDatum.
pub fn read(reference_inputs: List<Input>, anchor_ref: ByteArray) -> AnchorDatum {
  expect [anchor] = list.filter(
    reference_inputs,
    fn(i) {
      assets.quantity_of(i.output.value, anchor_ref, anchor_token_name) > 0
    },
  )
  expect anchor.output.address.payment_credential == Script(anchor_ref)
  expect InlineDatum(data) = anchor.output.datum
  expect d: AnchorDatum = data
  d
}
