import * as z from 'zod';

// Crebit Lock API shapes, typed from the partner reference (sections 2, 3, 10). Money and rates are decimal
// strings end to end; nothing here is ever converted to a float.

export const Decimal = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const Iso = z.string().min(20).max(40);

export const CrebitEnvSchema = z.enum(['sandbox', 'production']);
export const ChainSchema = z.enum(['solana', 'tron', 'ethereum', 'polygon']);
export const SettlementCurrencySchema = z.enum(['USDC', 'USDT']);
export const OracleSchema = z.enum(['redstone', 'binance']);
export const ContractTypeSchema = z.enum(['forward', 'option']);
export const DirectionSchema = z.enum(['BRL_TO_USD', 'USD_TO_BRL', 'MXN_TO_USD', 'USD_TO_MXN', 'NGN_TO_USD', 'USD_TO_NGN']);
export const NotionalCurrencySchema = z.enum(['USD', 'BRL', 'MXN', 'NGN']);
export const StrikeModeSchema = z.enum(['cip_fair', 'live_spot', 'custom']);
export const QuoteStatusSchema = z.enum(['created', 'failed']);
export const ContractStatusSchema = z.enum(['quote_created', 'funds_in_route', 'active', 'exercised', 'settled', 'expired', 'failed', 'defaulted', 'deposit_forfeited']);

export const QuoteRequestSchema = z.strictObject({
  customer_reference_id: z.string().min(1).max(256),
  customer_name: z.string().min(1).max(256),
  contract_type: ContractTypeSchema,
  direction: DirectionSchema,
  notional_currency: NotionalCurrencySchema,
  notional_amount: Decimal,
  window_start: Iso,
  window_end: Iso,
  chain: ChainSchema,
  settlement_currency: SettlementCurrencySchema,
  payout_wallet_address: z.string().min(1).max(128),
  strike_mode: StrikeModeSchema.optional(),
  target_strike: Decimal.optional(),
  provider_rate: Decimal.optional(),
  market_rate: Decimal.optional(),
  market_rate_timestamp: Iso.optional(),
  oracle: OracleSchema.optional(),
  source_chain: z.string().min(1).max(64).optional(),
});

// Responses are parsed loosely (looseObject): Crebit adds fields; we only pin what we read.
export const QuoteSchema = z.looseObject({
  id: z.string().min(1),
  status: QuoteStatusSchema,
  locked_rate: Decimal,
  strike_mode: StrikeModeSchema,
  strike_advantage_bps: z.number().int().nullable().optional(),
  premium_amount: Decimal,
  deposit_amount: Decimal.nullable(),
  total_amount: Decimal,
  amount_due: Decimal,
  window_start: Iso,
  window_end: Iso,
  chain: ChainSchema,
  settlement_currency: SettlementCurrencySchema,
  payout_wallet_address: z.string().nullable().optional(),
  expires_at: Iso,
  created_at: Iso,
  market_rate: Decimal.nullable().optional(),
  direction: DirectionSchema.optional(),
  contract_type: ContractTypeSchema.optional(),
  notional_currency: NotionalCurrencySchema.optional(),
  notional_amount: Decimal.optional(),
});

export const ContractRequestSchema = z.strictObject({
  quote_id: z.string().min(1),
  partner_transaction_reference: z.string().min(1).max(128).optional(),
  payout_wallet_address: z.string().min(1).max(128).optional(),
  payout_currency: SettlementCurrencySchema.optional(),
  payout_chain: ChainSchema.optional(),
});

export const ContractSchema = z.looseObject({
  id: z.string().min(1),
  crebit_contract_reference: z.string().min(1),
  contract_type: ContractTypeSchema,
  direction: DirectionSchema,
  notional_currency: NotionalCurrencySchema,
  locked_rate: Decimal,
  provider_rate_at_lock: Decimal.nullable().optional(),
  market_rate_at_lock: Decimal.nullable().optional(),
  premium_amount: Decimal,
  deposit_amount: Decimal.nullable(),
  total_amount: Decimal,
  window_start: Iso,
  window_end: Iso,
  chain: ChainSchema,
  settlement_currency: SettlementCurrencySchema,
  funding_wallet_address: z.string().min(1),
  payout_wallet_address: z.string().nullable().optional(),
  created_at: Iso,
  max_transaction_amount: Decimal.optional(),
  partner_transaction_reference: z.string().nullable().optional(),
});

export const ContractStatusViewSchema = z.looseObject({
  fx_contract_id: z.string().min(1),
  crebit_contract_reference: z.string().min(1),
  status: ContractStatusSchema,
  partner_transaction_reference: z.string().nullable().optional(),
  activated_at: Iso.nullable().optional(),
  exercised_at: Iso.nullable().optional(),
  settled_at: Iso.nullable().optional(),
  expired_at: Iso.nullable().optional(),
  failed_at: Iso.nullable().optional(),
  failure_reason: z.enum(['validation', 'payment', 'payout', 'system']).nullable().optional(),
  updated_at: Iso,
  open_margin_call: z.unknown().optional(),
});

export const CustomerReferenceSchema = z.looseObject({ id: z.string().min(1), customer_reference_id: z.string().min(1), created_at: Iso });

export const SupportedChainsSchema = z.looseObject({
  chains: z.array(
    z.looseObject({
      chain: ChainSchema,
      settlement_currencies: z.array(SettlementCurrencySchema),
      status: z.enum(['live', 'planned']),
      enabled: z.boolean(),
    }),
  ),
  funded_settlement_pairs: z.unknown().nullable().optional(),
});

export const PartnerMeSchema = z.looseObject({ partner_id: z.string(), partner_name: z.string(), api_key_id: z.string(), environment: CrebitEnvSchema });

export const WebhookEventSchema = z.looseObject({
  id: z.string(),
  fx_contract_id: z.string().nullable().optional(),
  direction: z.enum(['incoming', 'outgoing']),
  event_type: z.string(),
  status: z.string(),
  payload: z.unknown(),
  created_at: Iso,
});
export const PageSchema = <T extends z.ZodType>(item: T) => z.looseObject({ items: z.array(item), next_cursor: z.string().nullable() });

export type CrebitEnv = z.infer<typeof CrebitEnvSchema>;
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type ContractRequest = z.infer<typeof ContractRequestSchema>;
export type Contract = z.infer<typeof ContractSchema>;
export type ContractStatusView = z.infer<typeof ContractStatusViewSchema>;
export type ContractStatus = z.infer<typeof ContractStatusSchema>;
export type CustomerReference = z.infer<typeof CustomerReferenceSchema>;
export type SupportedChains = z.infer<typeof SupportedChainsSchema>;
export type PartnerMe = z.infer<typeof PartnerMeSchema>;
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/** Status table (reference 3.6): which states are final and which still expect partner or Crebit action. */
export const CONTRACT_PHASE: Record<ContractStatus, 'funding' | 'live' | 'settling' | 'terminal' | 'recoverable'> = {
  quote_created: 'funding',
  funds_in_route: 'funding',
  active: 'live',
  exercised: 'settling',
  settled: 'terminal',
  expired: 'terminal',
  failed: 'recoverable',
  defaulted: 'settling',
  deposit_forfeited: 'terminal',
};
