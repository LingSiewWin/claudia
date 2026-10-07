import { type ActionIR, ActionIRSchema, corridorOf, type Mandate } from '@authority/core';
import type { Quote } from './types';

// A read-back quote -> fx_lock Action IR. Every number comes from the quote; the caller only chose which quote.

export class QuoteActionError extends Error {
  override name = 'QuoteActionError';
}

/** "200.00" with 6 decimals -> "200000000". Throws on more decimals than the asset carries. */
export function decimalToUnits(value: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new QuoteActionError(`not a decimal string: ${JSON.stringify(value)}`);
  const [whole, frac = ''] = value.split('.') as [string, string?];
  if (frac.length > decimals) throw new QuoteActionError(`${value} has more than ${decimals} decimals`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}

/** The quote as a model or a human should see it: money as strings, nothing derived. */
export function quoteView(q: Quote) {
  return {
    quote_id: q.id,
    status: q.status,
    direction: q.direction ?? null,
    contract_type: q.contract_type ?? null,
    notional_amount: q.notional_amount ?? null,
    locked_rate: q.locked_rate,
    market_rate: q.market_rate ?? null,
    premium_amount: q.premium_amount,
    deposit_amount: q.deposit_amount,
    amount_due: q.amount_due,
    settlement_currency: q.settlement_currency,
    chain: q.chain,
    window_start: q.window_start,
    window_end: q.window_end,
    expires_at: q.expires_at,
  };
}

export function fxLockAction(q: Quote, o: { id: string; mandate: Pick<Mandate, 'id' | 'delegate' | 'asset'>; sourceVault: string; nowIso: string; rationale: string }): ActionIR {
  if (!q.direction || !q.contract_type || !q.notional_amount) throw new QuoteActionError(`quote ${q.id} does not carry direction, contract_type and notional_amount`);
  if (!q.payout_wallet_address) throw new QuoteActionError(`quote ${q.id} has no payout wallet`);
  const d = o.mandate.asset.decimals;
  const premium = decimalToUnits(q.premium_amount, d);
  const deposit = decimalToUnits(q.deposit_amount ?? '0', d);
  const tenorHours = Math.round((Date.parse(q.window_end) - Date.parse(q.window_start)) / 3_600_000);
  const checked = ActionIRSchema.safeParse({
    schema: 'action-ir/v0.1',
    id: o.id,
    mandate_id: o.mandate.id,
    actor: o.mandate.delegate.id,
    type: 'fx_lock',
    purpose: 'fx_hedge',
    counterparty: { id: 'crebit', display: 'Crebit (FX rate lock)' },
    amount: { value: (BigInt(premium) + BigInt(deposit)).toString(), asset: o.mandate.asset.symbol },
    recipient: { chain: 'solana', address: q.payout_wallet_address },
    source: { vault: o.sourceVault },
    fx: {
      corridor: corridorOf(q.direction),
      direction: q.direction,
      notional: decimalToUnits(q.notional_amount, d),
      tenor_hours: tenorHours,
      contract_type: q.contract_type,
      locked_rate: q.locked_rate,
      premium,
      deposit,
      quote_id: q.id,
      quote_expires_at: q.expires_at,
      provider: 'crebit',
      market_rate_at_quote: q.market_rate ?? null,
    },
    rationale: o.rationale,
    created_at: o.nowIso,
  });
  if (!checked.success) throw new QuoteActionError(`not a valid fx_lock action: ${checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return checked.data;
}
