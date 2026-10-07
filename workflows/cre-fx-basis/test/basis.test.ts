import { FxBasisReportSchema } from '@authority/chainlink/fx-codec';
import { canonicalHash } from '@authority/core';
import { describe, expect, it } from 'vitest';
import { basisBps, buildFxReport, type FeedRound, fromScaled, FxBasisRequestSchema, isForexMarketOpen, midFromFeed, toScaled } from '../src/basis';

// Live BRL/USD round read on 2026-10-07 (proxy 0x3126E7F38D5f60f4E2B6ec3511C7bdbD79317Df1, 8 decimals).
const ROUND: FeedRound = {
  decimals: 8,
  roundId: 18446744073709551981n,
  answer: 20133201n,
  updatedAt: 1791288527n,
  feedAddress: '0x3126E7F38D5f60f4E2B6ec3511C7bdbD79317Df1',
};
// Wednesday 2026-10-07 10:30:00 UTC = 06:30 ET (DST), market open.
const NOW = 1791369000;

const request = (over: Record<string, unknown> = {}) =>
  FxBasisRequestSchema.parse({
    schema: 'fx-basis-request/v0.1',
    action_hash: 'ab'.repeat(32),
    quote: {
      quote_id: 'q_demo_001',
      corridor: 'USD-BRL',
      locked_rate: '4.98',
      market_rate_at_quote: '4.96692006',
      premium: '0.0025',
      tenor_hours: 48,
      contract_type: 'forward',
      expires_at: '2026-10-09T10:00:00Z',
    },
    max_basis_bps: 50,
    max_feed_age_s: 86400,
    trigger_id: 'trig-1',
    ...over,
  });

describe('orientation and rounding', () => {
  it('inverts USD-per-BRL into BRL-per-USD at 8 decimals, half up', () => {
    // 1e16 / 20133201 = 496692092.5... -> rounds up to 496692006
    expect(midFromFeed(20133201n, 8)).toBe(496692006n);
    expect(fromScaled(midFromFeed(20133201n, 8))).toBe('4.96692006');
    expect(midFromFeed(25_000_000n, 8)).toBe(4_00000000n);
    expect(midFromFeed(2_500_000_000_000_000_000n, 18)).toBe(4_00000000n);
  });
  it('rejects non-positive answers', () => {
    expect(() => midFromFeed(0n, 8)).toThrow(/not positive/);
  });
  it('scales decimals exactly', () => {
    expect(toScaled('4.96692006')).toBe(496692006n);
    expect(toScaled('5')).toBe(500000000n);
    expect(fromScaled(5n)).toBe('0.00000005');
    expect(() => toScaled('4.123456789')).toThrow();
  });
  it('rounds basis up so a hair over the bound fails', () => {
    expect(basisBps(500000000n, 500000000n)).toBe(0n);
    expect(basisBps(510000000n, 500000000n)).toBe(200n); // +2% = 200 bps exactly
    expect(basisBps(490000000n, 500000000n)).toBe(200n); // symmetric
    expect(basisBps(500250001n, 500000000n)).toBe(6n); // 5.00002 bps -> 6
  });
});

describe('forex market hours (America/New_York)', () => {
  it.each([
    ['Wed 06:30 ET DST', NOW, true],
    ['Fri 16:59 ET DST', Date.UTC(2026, 9, 9, 20, 59, 59) / 1000, true],
    ['Fri 17:00 ET DST', Date.UTC(2026, 9, 9, 21, 0, 0) / 1000, false],
    ['Sat noon', Date.UTC(2026, 9, 10, 16) / 1000, false],
    ['Sun 23:59 ET DST', Date.UTC(2026, 9, 12, 3, 59, 59) / 1000, false],
    ['Mon 00:00 ET DST', Date.UTC(2026, 9, 12, 4, 0, 0) / 1000, true],
    ['Mon 00:00 ET standard time (Dec)', Date.UTC(2026, 11, 14, 5, 0, 0) / 1000, true],
    ['Sun 23:30 ET standard time (Dec)', Date.UTC(2026, 11, 14, 4, 30, 0) / 1000, false],
  ])('%s -> open=%s', (_l, t, open) => {
    expect(isForexMarketOpen(t)).toBe(open);
  });
});

describe('buildFxReport', () => {
  it('OK when the quote sits on the Chainlink mid', () => {
    const { report, report_hash } = buildFxReport(ROUND, request(), NOW);
    expect(report).toMatchObject({
      chainlink_mid: '4.96692006',
      basis_bps: 0,
      feed_age_s: NOW - 1791288527,
      market_open: true,
      result: 'OK',
      feed_address: '0x3126e7f38d5f60f4e2b6ec3511c7bdbd79317df1',
      chainlink_round_id: '18446744073709551981',
    });
    expect(FxBasisReportSchema.safeParse(report).success).toBe(true);
    expect(report_hash).toBe(canonicalHash(report));
    expect(buildFxReport(ROUND, request(), NOW).report_hash).toBe(report_hash);
  });
  it('BASIS_EXCEEDED at 200 bps', () => {
    const { report } = buildFxReport(ROUND, request({ quote: { ...request().quote, market_rate_at_quote: '5.06625846' } }), NOW);
    expect(report.basis_bps).toBe(200);
    expect(report.result).toBe('BASIS_EXCEEDED');
  });
  it('FEED_STALE with the 3600 s default on a 24 h heartbeat feed', () => {
    const req = FxBasisRequestSchema.parse({ ...request(), max_feed_age_s: undefined });
    expect(req.max_feed_age_s).toBe(3600);
    expect(buildFxReport(ROUND, req, NOW).report.result).toBe('FEED_STALE');
  });
  it('MARKET_CLOSED wins over everything else', () => {
    const sat = Date.UTC(2026, 9, 10, 16) / 1000;
    const { report } = buildFxReport(ROUND, request({ max_basis_bps: 0, max_feed_age_s: 1 }), sat);
    expect(report.result).toBe('MARKET_CLOSED');
    expect(report.market_open).toBe(false);
  });
  it('refuses a now earlier than the feed update', () => {
    expect(() => buildFxReport(ROUND, request(), 1791288000)).toThrow(/before feed update/);
  });
});
