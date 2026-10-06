import { serializeData } from '@meshsdk/core';
import { describe, expect, it } from 'vitest';
import { outRefData } from '../src/blueprint';
import {
  ANCHOR_REVOKE,
  type AnchorDatum,
  DEPOSIT,
  MINT_REDEEMER,
  PRINCIPAL_WITHDRAW,
  type PlutusJson,
  ZERO_VAULT_DATUM,
  anchorDatumData,
  parseAnchorDatum,
  parseVaultDatum,
  vaultDatumData,
} from '../src/data';

const cbor = (d: unknown) => serializeData(d as never, 'JSON');
const ANCHOR: AnchorDatum = {
  mandate_hash: '11'.repeat(32),
  version: 3,
  status: 'active',
  engine_vkey: '22'.repeat(32),
  principal_pkh: '33'.repeat(28),
  approver_pkh: '44'.repeat(28),
  asset_policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde',
  asset_name: '0014df10745553444d',
  autonomous_limit: 10_000_000n,
  hard_cap: 50_000_000n,
  daily_cap: 50_000_000n,
  treasury_minimum: 100_000_000n,
  valid_until: 1_806_451_200_000n,
};

describe('Plutus data codecs', () => {
  it('pin the CBOR the validators decode', () => {
    expect(cbor(vaultDatumData(ZERO_VAULT_DATUM))).toBe('d8799f000000ff');
    expect(cbor(DEPOSIT)).toBe('d87a80');
    expect(cbor(PRINCIPAL_WITHDRAW)).toBe('d87b80');
    expect(cbor(ANCHOR_REVOKE)).toBe('d87a80');
    expect(cbor(MINT_REDEEMER)).toBe('d87980');
    expect(cbor(outRefData({ txHash: 'a5'.repeat(32), outputIndex: 0 }))).toBe(`d8799f5820${'a5'.repeat(32)}00ff`);
  });

  it('put the approver key at field 5, right after the principal key', () => {
    const f = (anchorDatumData(ANCHOR) as { fields: PlutusJson[] }).fields;
    expect(f).toHaveLength(13);
    expect(f[4]).toEqual({ bytes: '33'.repeat(28) });
    expect(f[5]).toEqual({ bytes: '44'.repeat(28) });
    expect(f[6]).toEqual({ bytes: ANCHOR.asset_policy });
    expect(f[12]).toEqual({ int: ANCHOR.valid_until });
  });

  it('round-trip the anchor and vault datums', () => {
    expect(parseAnchorDatum(cbor(anchorDatumData(ANCHOR)))).toEqual(ANCHOR);
    const revoked = { ...ANCHOR, status: 'revoked' as const, version: 4 };
    expect(parseAnchorDatum(cbor(anchorDatumData(revoked)))).toEqual(revoked);
    const v = { last_nonce: 7n, day_index: 20733n, spent_today: 5_000_000n };
    expect(parseVaultDatum(cbor(vaultDatumData(v)))).toEqual(v);
  });

  it('refuse datums of another shape, including the 12-field anchor without an approver', () => {
    expect(() => parseVaultDatum('d87980')).toThrow(/VaultDatum/);
    expect(() => parseAnchorDatum(cbor(vaultDatumData(ZERO_VAULT_DATUM)))).toThrow(/AnchorDatum/);
    const old = anchorDatumData(ANCHOR) as { constructor: number; fields: PlutusJson[] };
    expect(() => parseAnchorDatum(cbor({ constructor: 0, fields: old.fields.filter((_, i) => i !== 5) }))).toThrow(/13 fields/);
  });
});
