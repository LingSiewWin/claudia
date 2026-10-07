// Deterministic FX basis logic. No SDK imports, no clock, no floats on the money path:
// the same feed round, request, and `now` always yield the same report and hash.
import { type FxBasisReport, FxBasisReportSchema, type FxResult } from '@authority/chainlink/fx-codec';
import { canonicalHash } from '@authority/core';
import * as z from 'zod';

const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/;
export const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);
export const DEFAULT_MAX_FEED_AGE_S = 3600;

export const FxBasisRequestSchema = z.strictObject({
  schema: z.literal('fx-basis-request/v0.1'),
  action_hash: z.string().regex(/^[0-9a-f]{64}$/),
  quote: z.strictObject({
    quote_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    corridor: z.literal('USD-BRL'),
    locked_rate: z.string().regex(DECIMAL),
    market_rate_at_quote: z.string().regex(DECIMAL),
    premium: z.string().regex(DECIMAL),
    tenor_hours: z.number().int().min(0),
    contract_type: z.string().min(1).max(32),
    expires_at: z.string().min(1).max(64),
  }),
  max_basis_bps: z.number().int().min(0).max(10_000),
  // The BRL/USD feed heartbeat is 86400 s (0.5% deviation), so the 3600 s default only passes
  // shortly after a deviation update; callers choose a bound that fits their mandate.
  max_feed_age_s: z.number().int().min(1).max(31_536_000).default(DEFAULT_MAX_FEED_AGE_S),
  // Epoch seconds. Defaults to the DON's runtime.now() so every node computes the same age.
  now: z.number().int().min(0).optional(),
  trigger_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
});
export type FxBasisRequest = z.infer<typeof FxBasisRequestSchema>;

export interface FeedRound {
  decimals: number;
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  feedAddress: string;
}

export function toScaled(decimal: string): bigint {
  if (!DECIMAL.test(decimal)) throw new RangeError(`not a decimal: ${decimal}`);
  const [int, frac = ''] = decimal.split('.');
  return BigInt(int!) * ONE + BigInt(frac.padEnd(SCALE, '0'));
}

export function fromScaled(v: bigint): string {
  const s = v.toString().padStart(SCALE + 1, '0');
  return `${s.slice(0, -SCALE)}.${s.slice(-SCALE)}`;
}

// The feed quotes USD per 1 BRL; the USD-BRL corridor quotes BRL per 1 USD, so invert
// (round half up) to 8 decimals.
export function midFromFeed(answer: bigint, decimals: number): bigint {
  if (answer <= 0n) throw new RangeError(`feed answer ${answer} is not positive`);
  const num = 10n ** BigInt(SCALE + decimals);
  return (num + answer / 2n) / answer;
}

// Rounded up: a deviation of 50.01 bps must not pass a 50 bps bound.
export function basisBps(market: bigint, mid: bigint): bigint {
  const diff = market > mid ? market - mid : mid - market;
  return (diff * 10_000n + mid - 1n) / mid;
}

// US DST: second Sunday of March 02:00 local (07:00 UTC) to first Sunday of November 02:00 local (06:00 UTC).
const nthSundayUtc = (year: number, month: number, nth: number, hourUtc: number): number => {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const date = 1 + ((7 - firstDow) % 7) + 7 * (nth - 1);
  return Date.UTC(year, month, date, hourUtc) / 1000;
};

// Forex feeds are valid 00:00 Monday to 17:00 Friday America/New_York (Chainlink 24/7 feeds doc).
// ponytail: market holidays are not modelled; add a holiday table if a closed-day quote ever matters.
export function isForexMarketOpen(nowS: number): boolean {
  const year = new Date(nowS * 1000).getUTCFullYear();
  const dst = nowS >= nthSundayUtc(year, 2, 2, 7) && nowS < nthSundayUtc(year, 10, 1, 6);
  const local = nowS - (dst ? 4 : 5) * 3600;
  const day = (Math.floor(local / 86400) + 4) % 7; // 0 = Sunday (epoch day 0 was a Thursday)
  const secondOfDay = ((local % 86400) + 86400) % 86400;
  return (day >= 1 && day <= 4) || (day === 5 && secondOfDay < 17 * 3600);
}

export function buildFxReport(round: FeedRound, req: FxBasisRequest, nowS: number): { report: FxBasisReport; report_hash: string } {
  const updatedAt = Number(round.updatedAt);
  if (!Number.isSafeInteger(updatedAt)) throw new RangeError('updatedAt out of range');
  if (nowS < updatedAt) throw new RangeError(`now ${nowS} is before feed update ${updatedAt}`);
  const mid = midFromFeed(round.answer, round.decimals);
  const bps = basisBps(toScaled(req.quote.market_rate_at_quote), mid);
  const feedAgeS = nowS - updatedAt;
  const marketOpen = isForexMarketOpen(nowS);
  const result: FxResult = !marketOpen
    ? 'MARKET_CLOSED'
    : feedAgeS > req.max_feed_age_s
      ? 'FEED_STALE'
      : bps > BigInt(req.max_basis_bps)
        ? 'BASIS_EXCEEDED'
        : 'OK';
  const report = FxBasisReportSchema.parse({
    schema: 'fx-basis/v0.1',
    action_hash: req.action_hash,
    quote_id: req.quote.quote_id,
    corridor: req.quote.corridor,
    locked_rate: req.quote.locked_rate,
    market_rate_at_quote: req.quote.market_rate_at_quote,
    chainlink_mid: fromScaled(mid),
    chainlink_round_id: round.roundId.toString(),
    chainlink_updated_at: updatedAt,
    feed_address: round.feedAddress.toLowerCase(),
    basis_bps: Number(bps > 0xffff_ffffn ? 0xffff_ffffn : bps),
    max_basis_bps: req.max_basis_bps,
    feed_age_s: feedAgeS,
    max_feed_age_s: req.max_feed_age_s,
    market_open: marketOpen,
    result,
    trigger_id: req.trigger_id,
  });
  return { report, report_hash: canonicalHash(report) };
}
