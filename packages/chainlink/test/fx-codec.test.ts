import { canonicalHash } from '@authority/core';
import { decodeAbiParameters, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { encodeFxReportPayload, FX_FIELDS_COMPONENTS, type FxBasisReport, fxReportFromStored, type FxStoredFields, toFxStoredFields } from '../src/fx-codec';

export const FX_FIXTURE: FxBasisReport = {
  schema: 'fx-basis/v0.1',
  action_hash: 'ab'.repeat(32),
  quote_id: 'q_demo_001',
  corridor: 'USD-BRL',
  locked_rate: '4.98',
  market_rate_at_quote: '4.96692093',
  chainlink_mid: '4.96692093',
  chainlink_round_id: '18446744073709551981',
  chainlink_updated_at: 1791288527,
  feed_address: '0x3126e7f38d5f60f4e2b6ec3511c7bdbd79317df1',
  basis_bps: 0,
  max_basis_bps: 50,
  feed_age_s: 80473,
  max_feed_age_s: 86400,
  market_open: true,
  result: 'OK',
  trigger_id: 'trig-1',
};

const decode = (payload: `0x${string}`) =>
  decodeAbiParameters([{ type: 'bytes32' }, { type: 'tuple', components: FX_FIELDS_COMPONENTS }], payload);

describe('fx codec', () => {
  it('pins report hash and payload bytes shared with the Solidity tests', () => {
    const { reportHash, payload } = encodeFxReportPayload(FX_FIXTURE);
    expect(reportHash).toBe('f610c9563b0cdcc808457a33b822624fde3aa231d5b820bf2e1166dea3b0355b');
    expect(keccak256(payload)).toBe('0x6a6063126942a845735257a00317b1f14f7a70e2390942a7b5843379f1e5cb93');
  });

  it.each([
    ['OK', FX_FIXTURE],
    ['BASIS_EXCEEDED', { ...FX_FIXTURE, market_rate_at_quote: '5.06625935', basis_bps: 200, result: 'BASIS_EXCEEDED' as const }],
    ['FEED_STALE', { ...FX_FIXTURE, max_feed_age_s: 3600, result: 'FEED_STALE' as const }],
    ['MARKET_CLOSED', { ...FX_FIXTURE, market_open: false, result: 'MARKET_CLOSED' as const }],
  ])('round-trips %s losslessly', (_l, report) => {
    const { reportHash, payload } = encodeFxReportPayload(report);
    const [hash, fields] = decode(payload);
    expect(hash).toBe(`0x${reportHash}`);
    const back = fxReportFromStored(fields as FxStoredFields);
    expect(back).toEqual(report);
    expect(canonicalHash(back)).toBe(reportHash);
  });

  it('rejects unknown result codes and corridors on the way back', () => {
    const f = toFxStoredFields(FX_FIXTURE);
    expect(() => fxReportFromStored({ ...f, result: 0 })).toThrow(/result code/);
    expect(() => fxReportFromStored({ ...f, result: 5 })).toThrow(/result code/);
    expect(() => fxReportFromStored({ ...f, corridor: 'USD-MXN' })).toThrow(/corridor/);
  });

  it('refuses a malformed report before encoding', () => {
    expect(() => encodeFxReportPayload({ ...FX_FIXTURE, chainlink_mid: '4.9669' })).toThrow();
    expect(() => encodeFxReportPayload({ ...FX_FIXTURE, basis_bps: -1 })).toThrow();
  });
});
