import * as z from 'zod';
import { parseShelleyAddress } from './address';

const U64 = 1n << 64n;
export const IdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const hexBytes = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
const Units = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/, { abort: true })
  .refine((s) => BigInt(s) < U64, 'must be < 2^64');
const PositiveUnits = Units.refine((s) => BigInt(s) > 0n, 'must be > 0');
const Ed25519Key = z.string().regex(/^ed25519:[0-9a-f]{64}$/);
const AssetSymbol = z.string().regex(/^[A-Z]{2,10}$/);
const OnViolation = z.enum(['DENY', 'ESCALATE']);
const DecimalString = z.string().regex(/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/);
const SolanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

// FX rate lock (Crebit). Corridors are unordered pairs; direction is Crebit's ordered enum and must be a leg of the corridor.
export const FxCorridorSchema = z.enum(['USD-BRL', 'USD-MXN', 'USD-NGN']);
export const FxDirectionSchema = z.enum(['USD_TO_BRL', 'BRL_TO_USD', 'USD_TO_MXN', 'MXN_TO_USD', 'USD_TO_NGN', 'NGN_TO_USD']);
export const FxContractTypeSchema = z.enum(['option', 'forward']);
export const corridorOf = (direction: z.infer<typeof FxDirectionSchema>): z.infer<typeof FxCorridorSchema> => {
  const [a, , b] = direction.split('_') as [string, string, string];
  return (a === 'USD' ? `USD-${b}` : `USD-${a}`) as z.infer<typeof FxCorridorSchema>;
};

/** Mandate fx block: what an fx_lock may do. Forwards (open-ended margin liability) only when listed. */
export const MandateFxSchema = z.strictObject({
  corridors: z.array(FxCorridorSchema).min(1),
  max_notional: Units,
  max_tenor_hours: z.number().int().min(1).max(180 * 24),
  contract_types: z.array(FxContractTypeSchema).min(1).default(['option']),
  max_basis_bps: z.number().int().min(0).max(10_000),
  counterparty: z.literal('crebit'),
});

/** Action fx block: the Crebit quote as the agent read it. Units are base units of the mandate asset (the funding stablecoin). */
export const ActionFxSchema = z.strictObject({
  corridor: FxCorridorSchema,
  direction: FxDirectionSchema,
  notional: PositiveUnits,
  tenor_hours: z.number().int().min(1).max(180 * 24),
  contract_type: FxContractTypeSchema,
  locked_rate: DecimalString,
  premium: Units,
  deposit: Units,
  quote_id: z.string().min(1).max(64),
  quote_expires_at: z.iso.datetime(),
  provider: z.literal('crebit'),
  market_rate_at_quote: DecimalString.nullable(),
});

const common = { id: IdSchema, on_violation: OnViolation, approver: z.string().min(1).max(32).optional() };

export const ConstraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('purpose_in'), values: z.array(IdSchema).min(1) }),
  z.strictObject({ ...common, kind: z.literal('action_in'), values: z.array(IdSchema).min(1) }),
  z.strictObject({ ...common, kind: z.literal('counterparty_in'), values: z.array(IdSchema).min(1) }),
  z.strictObject({ ...common, kind: z.literal('asset_eq'), value: AssetSymbol }),
  z.strictObject({ ...common, kind: z.literal('amount_lte'), value: Units }),
  z.strictObject({ ...common, kind: z.literal('daily_spend_lte'), value: Units }),
  z.strictObject({ ...common, kind: z.literal('balance_after_gte'), value: Units }),
  z.strictObject({ ...common, kind: z.literal('verified_facts'), source: z.enum(['stripe', 'crebit']) }),
  // fx_* kinds read their limits from mandate.fx and apply only to fx_lock actions.
  z.strictObject({ ...common, kind: z.literal('fx_corridor_in') }),
  z.strictObject({ ...common, kind: z.literal('fx_notional_lte') }),
  z.strictObject({ ...common, kind: z.literal('fx_tenor_lte') }),
  z.strictObject({ ...common, kind: z.literal('fx_contract_type_in') }),
  z.strictObject({ ...common, kind: z.literal('fx_quote_fresh') }),
  z.strictObject({ ...common, kind: z.literal('fx_basis_lte') }),
]);
export const FX_CONSTRAINT_KINDS = ['fx_corridor_in', 'fx_notional_lte', 'fx_tenor_lte', 'fx_contract_type_in', 'fx_quote_fresh', 'fx_basis_lte'] as const;

export const MandateSchema = z.strictObject({
  schema: z.literal('mandate/v0.1'),
  id: IdSchema,
  version: z.number().int().min(1).max(0xffffffff),
  status: z.enum(['active', 'revoked']),
  principal: z.strictObject({
    type: z.literal('organization'),
    id: IdSchema,
    name: z.string().min(1).max(128),
    cardano_key_hash: hexBytes(28),
  }),
  delegate: z.strictObject({ type: z.literal('agent'), id: IdSchema, public_key: Ed25519Key }),
  approvers: z.array(z.strictObject({ role: z.string().min(1).max(32), cardano_key_hash: hexBytes(28) })).min(1),
  authority_engine: z.strictObject({ public_key: Ed25519Key }),
  asset: z.strictObject({ symbol: AssetSymbol, decimals: z.number().int().min(0).max(18) }),
  validity: z.strictObject({ starts_at: z.iso.datetime(), expires_at: z.iso.datetime() }),
  delegation: z.strictObject({ allowed: z.literal(false) }),
  // Human attention is budgeted like money: ESCALATE outcomes per UTC day. The next one is a DENY and nobody is paged.
  interrupt_budget: z.strictObject({ per_day: z.number().int().min(0).max(10_000) }),
  constraints: z.array(ConstraintSchema).min(1),
  fx: MandateFxSchema.optional(),
});

export const ActionTypeSchema = z.enum(['pay_invoice', 'purchase', 'transfer', 'fx_lock']);

export const ActionIRSchema = z.strictObject({
  schema: z.literal('action-ir/v0.1'),
  id: IdSchema,
  mandate_id: IdSchema,
  actor: IdSchema,
  type: ActionTypeSchema,
  purpose: IdSchema,
  counterparty: z.strictObject({ id: IdSchema, display: z.string().min(1).max(128) }),
  amount: z.strictObject({ value: PositiveUnits, asset: AssetSymbol }),
  recipient: z.discriminatedUnion('chain', [
    z.strictObject({
      chain: z.literal('cardano'),
      address: z
        .string()
        .max(200)
        .regex(/^[a-z0-9_]+$/, { abort: true })
        .refine((address) => {
          try {
            parseShelleyAddress(address);
            return true;
          } catch {
            return false;
          }
        }, 'invalid Shelley address'),
    }),
    // fx_lock: the treasury's settlement wallet on Crebit's chain (where the FX delta is paid).
    z.strictObject({ chain: z.literal('solana'), address: SolanaAddress }),
  ]),
  source: z.strictObject({ vault: IdSchema }),
  reference: z
    .strictObject({ invoice_id: z.string().min(1).max(64), invoice_number: z.string().min(1).max(64) })
    .optional(),
  fx: ActionFxSchema.optional(),
  rationale: z.string().max(2000),
  created_at: z.iso.datetime(),
})
  .refine((a) => (a.type === 'fx_lock') === (a.fx !== undefined), 'fx block present exactly when type is fx_lock')
  .refine((a) => a.fx === undefined || corridorOf(a.fx.direction) === a.fx.corridor, 'fx.direction must be a leg of fx.corridor')
  // amount.value is what leaves the treasury: the premium (option) plus the deposit (forward; 0 for options).
  .refine((a) => a.fx === undefined || BigInt(a.amount.value) === BigInt(a.fx.premium) + BigInt(a.fx.deposit), 'amount.value must equal fx.premium + fx.deposit');

export const StateSchema = z.strictObject({
  vault_balance: Units,
  spent_today: Units,
  day_index: z.number().int().min(0),
  last_nonce: Units,
  anchor_version: z.number().int().min(1),
  anchor_status: z.enum(['active', 'revoked']),
  observed_at_slot: z.number().int().min(0),
  // Escalations already counted today (engine record). Absent means none.
  escalations_today: z.number().int().min(0).optional(),
  escalation_day_index: z.number().int().min(0).optional(),
});

export const BondStatusSchema = z.enum(['required', 'locked', 'refunded', 'captured', 'expired']);

/** Body of the HTTP 402 reply: what the agent must lock in escrow before a human is interrupted. */
export const EscalationPriceSchema = z.strictObject({
  schema: z.literal('escalation-price/v0.1'),
  approval_id: z.string().min(1).max(64),
  network: z.enum(['cardano-preprod', 'cardano-mainnet']),
  asset: z.strictObject({ policy_id: z.string().regex(/^([0-9a-f]{56})?$/), asset_name: z.string().regex(/^[0-9a-f]{0,64}$/), symbol: AssetSymbol }),
  amount: PositiveUnits,
  escrow_address: z.string().min(1).max(200),
  action_hash: hexBytes(32),
  approver_key_hash: hexBytes(28),
  locked_until_ms: z.number().int().positive(),
  interrupt_budget: z.strictObject({ used: z.number().int().min(0), per_day: z.number().int().min(0) }),
});

/** A bond on record: the escrow UTxO an agent locked to escalate one action, and what became of it. */
export const BondSchema = z.strictObject({
  schema: z.literal('bond/v0.1'),
  approval_id: z.string().min(1).max(64),
  action_hash: hexBytes(32),
  mandate_id: IdSchema,
  amount: PositiveUnits,
  asset: AssetSymbol,
  escrow_address: z.string().min(1).max(200),
  tx_hash: hexBytes(32).nullable(),
  output_index: z.number().int().min(0).nullable(),
  locked_until_ms: z.number().int().positive(),
  status: BondStatusSchema,
  outcome_tx_hash: hexBytes(32).nullable(),
});

export const FactReasonSchema = z.enum([
  'INVOICE_NOT_FOUND',
  'CUSTOMER_MISMATCH',
  'INVOICE_NOT_OPEN',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'RECIPIENT_MISMATCH',
]);

export const VerificationReportSchema = z
  .strictObject({
    schema: z.literal('verification/v0.1'),
    action_hash: hexBytes(32),
    invoice_id: z.string().min(1).max(64),
    invoice_hash: hexBytes(32),
    verified_amount: Units.nullable(),
    verified_currency: z.string().max(8).nullable(),
    verified_recipient: z.string().max(200).nullable(),
    status: z.string().max(32).nullable(),
    facts: z.strictObject({
      exists: z.boolean(),
      customer_match: z.boolean(),
      status_open: z.boolean(),
      amount_match: z.boolean(),
      currency_match: z.boolean(),
      recipient_match: z.boolean(),
    }),
    result: z.enum(['VERIFIED', 'MISMATCH']),
    reason: FactReasonSchema.nullable(),
    trigger_id: z.string().min(1).max(64),
  })
  .refine((r) => (r.result === 'VERIFIED') === (r.reason === null), 'reason must be null exactly when VERIFIED');

export const FxFactReasonSchema = z.enum(['QUOTE_NOT_FOUND', 'RATE_MISMATCH', 'PREMIUM_MISMATCH', 'EXPIRY_MISMATCH', 'QUOTE_OFF_MARKET']);

/** Verification of an fx_lock against the Crebit quote read back by GET /fx/quotes/{id} (verified_facts source crebit). */
export const FxVerificationReportSchema = z
  .strictObject({
    schema: z.literal('fx-verification/v0.1'),
    action_hash: hexBytes(32),
    quote_id: z.string().min(1).max(64),
    /** sha256 of the canonical quote JSON as read back. */
    quote_hash: hexBytes(32),
    verified_rate: DecimalString.nullable(),
    verified_premium: Units.nullable(),
    verified_deposit: Units.nullable(),
    verified_expires_at: z.iso.datetime().nullable(),
    market_rate: DecimalString.nullable(),
    /** |locked_rate - market_rate| / market_rate in bps; null when no market rate is known. */
    basis_bps: z.number().int().min(0).nullable(),
    basis_source: z.enum(['quote', 'chainlink']).nullable(),
    facts: z.strictObject({
      quote_exists: z.boolean(),
      rate_match: z.boolean(),
      premium_match: z.boolean(),
      expiry_match: z.boolean(),
      basis_ok: z.boolean(),
    }),
    result: z.enum(['VERIFIED', 'MISMATCH']),
    reason: FxFactReasonSchema.nullable(),
    trigger_id: z.string().min(1).max(64),
  })
  .refine((r) => (r.result === 'VERIFIED') === (r.reason === null), 'reason must be null exactly when VERIFIED');

export const AnyVerificationReportSchema = z.union([VerificationReportSchema, FxVerificationReportSchema]);

export const ReasonCodeSchema = z.enum([
  'INVALID_PROPOSAL',
  'INVALID_AGENT_SIGNATURE',
  'AGENT_NOT_DELEGATE',
  'WRONG_MANDATE',
  'MANDATE_REVOKED',
  'MANDATE_VERSION_MISMATCH',
  'MANDATE_NOT_STARTED',
  'MANDATE_EXPIRED',
  'PURPOSE_NOT_AUTHORIZED',
  'ACTION_NOT_AUTHORIZED',
  'ASSET_NOT_AUTHORIZED',
  'AMOUNT_ABOVE_HARD_CAP',
  'DAILY_CAP_EXCEEDED',
  'TREASURY_FLOOR_VIOLATION',
  'INVOICE_NOT_FOUND',
  'CUSTOMER_MISMATCH',
  'INVOICE_NOT_OPEN',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'RECIPIENT_MISMATCH',
  'VERIFICATION_UNAVAILABLE',
  'COUNTERPARTY_NOT_APPROVED',
  'ABOVE_AUTONOMOUS_LIMIT',
  'PRINCIPAL_DECLINED',
  'INTERRUPT_BUDGET_EXHAUSTED',
  'FX_NOT_AUTHORIZED',
  'FX_CORRIDOR_NOT_AUTHORIZED',
  'FX_NOTIONAL_ABOVE_LIMIT',
  'FX_TENOR_ABOVE_LIMIT',
  'FX_CONTRACT_TYPE_NOT_AUTHORIZED',
  'FX_QUOTE_STALE',
  'QUOTE_NOT_FOUND',
  'RATE_MISMATCH',
  'PREMIUM_MISMATCH',
  'EXPIRY_MISMATCH',
  'QUOTE_OFF_MARKET',
]);

export type Mandate = z.infer<typeof MandateSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type ActionIR = z.infer<typeof ActionIRSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type State = z.infer<typeof StateSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type FxVerificationReport = z.infer<typeof FxVerificationReportSchema>;
export type AnyVerificationReport = z.infer<typeof AnyVerificationReportSchema>;
export type MandateFx = z.infer<typeof MandateFxSchema>;
export type ActionFx = z.infer<typeof ActionFxSchema>;
export type FxCorridor = z.infer<typeof FxCorridorSchema>;
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;
export type Outcome = 'ALLOW' | 'ESCALATE' | 'DENY';
export type BondStatus = z.infer<typeof BondStatusSchema>;
export type EscalationPrice = z.infer<typeof EscalationPriceSchema>;
export type Bond = z.infer<typeof BondSchema>;
export type VerifiedInvoiceReport = VerifiedReport & { report: VerificationReport };
export interface VerifiedReport {
  report: AnyVerificationReport;
  report_hash: string;
  block_time_ms: number;
}
