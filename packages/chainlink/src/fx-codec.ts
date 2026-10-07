// FX basis attestation reports: schema, on-chain layout in FxBasisRegistry, and the
// encoder/decoder shared by the CRE workflow and the engine-side reader.
import { canonicalHash } from '@authority/core';
import { encodeAbiParameters, getAddress, type Hex } from 'viem';
import * as z from 'zod';

const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const U32 = 0xffff_ffff;
const U64 = 1n << 64n;
const U80 = 1n << 80n;

export const FX_RESULTS = ['OK', 'BASIS_EXCEEDED', 'FEED_STALE', 'MARKET_CLOSED'] as const;
export type FxResult = (typeof FX_RESULTS)[number];
export const FX_RESULT_CODE: Record<FxResult, number> = { OK: 1, BASIS_EXCEEDED: 2, FEED_STALE: 3, MARKET_CLOSED: 4 };

export const FxBasisReportSchema = z.strictObject({
  schema: z.literal('fx-basis/v0.1'),
  action_hash: z.string().regex(HEX64),
  quote_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  corridor: z.literal('USD-BRL'),
  locked_rate: z.string().regex(DECIMAL),
  market_rate_at_quote: z.string().regex(DECIMAL),
  // BRL per USD (the corridor's quote convention), 8 decimals, inverted from the BRL/USD feed.
  chainlink_mid: z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{8}$/),
  chainlink_round_id: z.string().regex(/^(0|[1-9][0-9]{0,24})$/).refine((s) => BigInt(s) < U80, '< 2^80'),
  chainlink_updated_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  feed_address: z.string().regex(/^0x[0-9a-f]{40}$/),
  basis_bps: z.number().int().min(0).max(U32),
  max_basis_bps: z.number().int().min(0).max(U32),
  feed_age_s: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  max_feed_age_s: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  market_open: z.boolean(),
  result: z.enum(FX_RESULTS),
  trigger_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
});
export type FxBasisReport = z.infer<typeof FxBasisReportSchema>;

export const FX_FIELDS_COMPONENTS = [
  { name: 'actionHash', type: 'bytes32' },
  { name: 'quoteId', type: 'string' },
  { name: 'corridor', type: 'string' },
  { name: 'lockedRate', type: 'string' },
  { name: 'marketRateAtQuote', type: 'string' },
  { name: 'chainlinkMid', type: 'string' },
  { name: 'chainlinkRoundId', type: 'uint80' },
  { name: 'chainlinkUpdatedAt', type: 'uint64' },
  { name: 'feedAddress', type: 'address' },
  { name: 'basisBps', type: 'uint32' },
  { name: 'maxBasisBps', type: 'uint32' },
  { name: 'feedAgeS', type: 'uint64' },
  { name: 'maxFeedAgeS', type: 'uint64' },
  { name: 'marketOpen', type: 'bool' },
  { name: 'result', type: 'uint8' },
  { name: 'triggerId', type: 'string' },
] as const;

const FX_STORED_COMPONENTS = [
  { name: 'fields', type: 'tuple', components: FX_FIELDS_COMPONENTS },
  { name: 'blockTime', type: 'uint64' },
] as const;

export const FX_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getReport',
    stateMutability: 'view',
    inputs: [{ name: 'reportHash', type: 'bytes32' }],
    outputs: [{ name: 'stored', type: 'tuple', components: FX_STORED_COMPONENTS }],
  },
  {
    type: 'function',
    name: 'latestReport',
    stateMutability: 'view',
    inputs: [{ name: 'actionHash', type: 'bytes32' }],
    outputs: [
      { name: 'reportHash', type: 'bytes32' },
      { name: 'stored', type: 'tuple', components: FX_STORED_COMPONENTS },
    ],
  },
  {
    type: 'event',
    name: 'FxBasisAttested',
    inputs: [
      { name: 'actionHash', type: 'bytes32', indexed: true },
      { name: 'reportHash', type: 'bytes32', indexed: true },
      { name: 'result', type: 'uint8', indexed: false },
    ],
  },
] as const;

export interface FxStoredFields {
  actionHash: Hex;
  quoteId: string;
  corridor: string;
  lockedRate: string;
  marketRateAtQuote: string;
  chainlinkMid: string;
  chainlinkRoundId: bigint;
  chainlinkUpdatedAt: bigint;
  feedAddress: Hex;
  basisBps: number;
  maxBasisBps: number;
  feedAgeS: bigint;
  maxFeedAgeS: bigint;
  marketOpen: boolean;
  result: number;
  triggerId: string;
}

export function toFxStoredFields(r: FxBasisReport): FxStoredFields {
  return {
    actionHash: `0x${r.action_hash}`,
    quoteId: r.quote_id,
    corridor: r.corridor,
    lockedRate: r.locked_rate,
    marketRateAtQuote: r.market_rate_at_quote,
    chainlinkMid: r.chainlink_mid,
    chainlinkRoundId: BigInt(r.chainlink_round_id),
    chainlinkUpdatedAt: BigInt(r.chainlink_updated_at),
    feedAddress: getAddress(r.feed_address),
    basisBps: r.basis_bps,
    maxBasisBps: r.max_basis_bps,
    feedAgeS: BigInt(r.feed_age_s),
    maxFeedAgeS: BigInt(r.max_feed_age_s),
    marketOpen: r.market_open,
    result: FX_RESULT_CODE[r.result],
    triggerId: r.trigger_id,
  };
}

const safeInt = (v: bigint, name: string): number => {
  if (v < 0n || v >= U64 || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} out of range`);
  return Number(v);
};

export function fxReportFromStored(f: FxStoredFields): FxBasisReport {
  const result = FX_RESULTS[f.result - 1];
  if (!Number.isInteger(f.result) || result === undefined) throw new RangeError(`result code ${f.result}`);
  if (f.corridor !== 'USD-BRL') throw new RangeError(`corridor ${f.corridor}`);
  return FxBasisReportSchema.parse({
    schema: 'fx-basis/v0.1',
    action_hash: f.actionHash.slice(2).toLowerCase(),
    quote_id: f.quoteId,
    corridor: f.corridor,
    locked_rate: f.lockedRate,
    market_rate_at_quote: f.marketRateAtQuote,
    chainlink_mid: f.chainlinkMid,
    chainlink_round_id: f.chainlinkRoundId.toString(),
    chainlink_updated_at: safeInt(f.chainlinkUpdatedAt, 'chainlinkUpdatedAt'),
    feed_address: f.feedAddress.toLowerCase(),
    basis_bps: f.basisBps,
    max_basis_bps: f.maxBasisBps,
    feed_age_s: safeInt(f.feedAgeS, 'feedAgeS'),
    max_feed_age_s: safeInt(f.maxFeedAgeS, 'maxFeedAgeS'),
    market_open: f.marketOpen,
    result,
    trigger_id: f.triggerId,
  });
}

// The onReport payload: abi.encode(bytes32 reportHash, Fields fields).
export function encodeFxReportPayload(r: FxBasisReport): { reportHash: string; payload: Hex } {
  FxBasisReportSchema.parse(r);
  const reportHash = canonicalHash(r);
  const payload = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'tuple', components: FX_FIELDS_COMPONENTS }],
    [`0x${reportHash}`, toFxStoredFields(r)],
  );
  return { reportHash, payload };
}
