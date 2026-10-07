import type { Quote } from '@authority/crebit';
import { type ActionIR, canonicalHash, canonicalJson, type FxVerificationReport, FxVerificationReportSchema, sha256Hex, type VerifiedReport } from '@authority/core';
import { decimalToUnits } from '@authority/llm';

/*
 * fx_quote verification: the quote the agent proposed, read back from Crebit (GET /fx/quotes/{id}) and compared
 * with the action. Produces the fx-verification/v0.1 report the engine's verified_facts(crebit) and fx_basis_lte
 * constraints consume. Until the CRE lane supplies a Chainlink market mid, the basis comes from the quote's own
 * market_rate (basis_source 'quote'); with no keys this fails closed, it never invents a quote.
 */

/** Deterministic quote read. null = Crebit has no such quote. */
export type ReadQuote = (quoteId: string) => Promise<Quote | null>;

export type FxVerificationOutcome = { status: 'reported'; verified: VerifiedReport } | { status: 'unavailable'; error: string };
export type VerifyFx = (action: ActionIR, triggerId: string, o: { maxBasisBps: number; decimals: number }) => Promise<FxVerificationOutcome>;

export const CREBIT_NOT_CONFIGURED = 'Crebit keys not configured (CREBIT_ENV, CREBIT_KEY_ID, CREBIT_KEY_SECRET)';

const SCALE = 18n;
const toScaled = (decimal: string): bigint => {
  const [whole, frac = ''] = decimal.split('.') as [string, string?];
  return BigInt(whole) * 10n ** SCALE + BigInt((frac + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE)));
};

/** |locked - market| / market in whole bps (integer math on decimal strings, rounded down). */
export function basisBps(lockedRate: string, marketRate: string): number {
  const locked = toScaled(lockedRate);
  const market = toScaled(marketRate);
  if (market <= 0n) throw new RangeError('market rate must be positive');
  const diff = locked > market ? locked - market : market - locked;
  return Number((diff * 10_000n) / market);
}

const units = (decimal: string | null | undefined, decimals: number): string | null => {
  if (decimal === null || decimal === undefined) return null;
  try {
    return decimalToUnits(decimal, decimals);
  } catch {
    return null;
  }
};

export function fxVerifier(readQuote: ReadQuote | null, now: () => number): VerifyFx {
  return async (action, triggerId, o) => {
    const fx = action.fx;
    if (fx === undefined) return { status: 'unavailable', error: 'action has no fx block' };
    if (readQuote === null) return { status: 'unavailable', error: CREBIT_NOT_CONFIGURED };
    let quote: Quote | null;
    try {
      quote = await readQuote(fx.quote_id);
    } catch (error) {
      return { status: 'unavailable', error: `crebit: ${(error as Error).message}` };
    }
    const premium = units(quote?.premium_amount, o.decimals);
    const deposit = quote ? (units(quote.deposit_amount ?? '0', o.decimals) ?? null) : null;
    const marketRate = quote?.market_rate ?? null;
    // Reference 3.1: strike_advantage_bps is |locked_rate - market_rate| in bps, the same quantity, computed by Crebit.
    const basis = marketRate !== null && quote ? basisBps(quote.locked_rate, marketRate) : (quote?.strike_advantage_bps ?? null);
    const facts = {
      quote_exists: quote !== null && quote.status === 'created' && Date.parse(quote.expires_at) > now(),
      rate_match: quote !== null && quote.locked_rate === fx.locked_rate,
      premium_match: quote !== null && premium === fx.premium && deposit === fx.deposit,
      expiry_match: quote !== null && quote.expires_at === fx.quote_expires_at,
      basis_ok: basis !== null && basis <= o.maxBasisBps,
    };
    const order = [
      ['quote_exists', 'QUOTE_NOT_FOUND'],
      ['rate_match', 'RATE_MISMATCH'],
      ['premium_match', 'PREMIUM_MISMATCH'],
      ['expiry_match', 'EXPIRY_MISMATCH'],
      ['basis_ok', 'QUOTE_OFF_MARKET'],
    ] as const;
    const failed = order.find(([k]) => !facts[k]);
    const report: FxVerificationReport = FxVerificationReportSchema.parse({
      schema: 'fx-verification/v0.1',
      action_hash: canonicalHash(action),
      quote_id: fx.quote_id,
      quote_hash: sha256Hex(quote === null ? `quote:absent:${fx.quote_id}` : canonicalJson(quote)),
      verified_rate: quote?.locked_rate ?? null,
      verified_premium: premium,
      verified_deposit: deposit,
      verified_expires_at: quote?.expires_at ?? null,
      market_rate: marketRate,
      basis_bps: basis,
      basis_source: basis === null ? null : 'quote',
      facts,
      result: failed ? 'MISMATCH' : 'VERIFIED',
      reason: failed ? failed[1] : null,
      trigger_id: triggerId,
    });
    return { status: 'reported', verified: { report, report_hash: canonicalHash(report), block_time_ms: now() } };
  };
}
