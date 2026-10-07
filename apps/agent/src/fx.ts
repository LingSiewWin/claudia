import { type CrebitClient, fxLockAction, type Quote, type QuoteRequest, quoteView } from '@authority/crebit';
import * as z from 'zod';
export { fxLockAction, quoteView };

// The agent's view of Crebit: it may price a lock (free, expires in 15 min) and read a quote back. It can never
// create a contract or move funds; that sits behind the engine and the human's wallet.

export const FxQuoteArgsSchema = z.strictObject({
  direction: z.enum(['USD_TO_BRL', 'BRL_TO_USD', 'USD_TO_MXN', 'MXN_TO_USD', 'USD_TO_NGN', 'NGN_TO_USD']).describe('Corridor and flow, for example USD_TO_BRL'),
  notional_amount: z.string().regex(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/).describe('Notional in the USD leg, decimal string, for example "20000.00"'),
  tenor_hours: z.number().int().min(1).max(180 * 24).describe('Hours the locked rate must hold (window length)'),
  contract_type: z.enum(['option', 'forward']).default('option').describe('option unless the mandate lists forward'),
  payout_wallet_address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).describe('Treasury Solana wallet that receives the FX delta'),
});
export type FxQuoteArgs = z.infer<typeof FxQuoteArgsSchema>;

export const ProposeFxLockArgsSchema = z.strictObject({
  quote_id: z.string().min(1).max(64).describe('Quote id from get_fx_quote'),
  rationale: z.string().min(1).max(2000).describe('Why this hedge should be locked, in one or two sentences'),
});

export interface FxQuoteSource {
  /** Registers the principal as Crebit customer reference and prices a lock. */
  quote(args: FxQuoteArgs, customer: { reference: string; name: string }): Promise<Quote>;
  /** Reads a quote back; null when Crebit has no such quote. */
  get(quoteId: string): Promise<Quote | null>;
}

export const CREBIT_NOT_CONFIGURED = 'Crebit keys not configured (CREBIT_ENV, CREBIT_KEY_ID, CREBIT_KEY_SECRET)';

const iso = (ms: number) => new Date(ms).toISOString().replace('.000', '');

/** Live source over the Lock API. live_spot: Crebit prices off its own TWAP, so the agent supplies no rate. */
export function crebitQuoteSource(client: CrebitClient, now: () => number): FxQuoteSource {
  return {
    async quote(a, customer) {
      await client.createCustomerReference(customer.reference);
      const start = now() + 5 * 60_000;
      const req: QuoteRequest = {
        customer_reference_id: customer.reference,
        customer_name: customer.name,
        contract_type: a.contract_type,
        direction: a.direction,
        notional_currency: 'USD',
        notional_amount: a.notional_amount,
        window_start: iso(start),
        window_end: iso(start + a.tenor_hours * 3_600_000),
        chain: 'solana',
        settlement_currency: 'USDC',
        payout_wallet_address: a.payout_wallet_address,
        strike_mode: 'live_spot',
        oracle: 'redstone',
      };
      return client.createQuote(req);
    },
    get: (id) => client.getQuote(id),
  };
}
