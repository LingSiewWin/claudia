use aiken/collection/list
use aiken/primitive/bytearray
use authority/types.{AnchorDatum, anchor_token_name}
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{InlineDatum, Input}

/// M4: limits are ordered and every key, hash and name has its exact length.
/// The version fits the authorization message's u32 `mandate_version`: a
/// larger one could never be signed for, and versions only go up.
pub fn valid_datum(d: AnchorDatum) -> Bool {
  and {
    d.version >= 1,
    d.version <= 4_294_967_295,
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
/// anchor script address, and it carries an inline AnchorDatum. Each failure
/// has its own `r2 ?` label so a rejection names the broken part.
pub fn read(reference_inputs: List<Input>, anchor_ref: ByteArray) -> AnchorDatum {
  when
    list.filter(
      reference_inputs,
      fn(i) {
        assets.quantity_of(i.output.value, anchor_ref, anchor_token_name) > 0
      },
    )
  is {
    [anchor] ->
      if anchor.output.address.payment_credential == Script(anchor_ref) {
        when anchor.output.datum is {
          InlineDatum(data) ->
            if data is d: AnchorDatum {
              d
            } else {
              fail @"r2 ? anchor datum is not an AnchorDatum"
            }
          _ -> fail @"r2 ? anchor datum is not inline"
        }
      } else {
        fail @"r2 ? anchor NFT is not at the anchor script"
      }
    _ -> fail @"r2 ? need exactly one anchor reference input"
  }
}
