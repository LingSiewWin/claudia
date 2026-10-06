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
const OnViolation = z.enum(['DENY', 'REQUIRE_APPROVAL']);

const common = { id: IdSchema, on_violation: OnViolation, approver: z.string().min(1).max(32).optional() };

export const ConstraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('purpose_in'), values: z.array(IdSchema).min(1) }),
  z.strictObject({ ...common, kind: z.literal('action_in'), values: z.array(IdSchema).min(1) }),
  z.strictObject({ ...common, kind: z.literal('counterparty_in'), values: z.array(IdSchema).min(1) }),
  z.strictObject({ ...common, kind: z.literal('asset_eq'), value: AssetSymbol }),
  z.strictObject({ ...common, kind: z.literal('amount_lte'), value: Units }),
  z.strictObject({ ...common, kind: z.literal('daily_spend_lte'), value: Units }),
  z.strictObject({ ...common, kind: z.literal('balance_after_gte'), value: Units }),
  z.strictObject({ ...common, kind: z.literal('verified_facts'), source: z.literal('stripe') }),
]);

export const MandateSchema = z.strictObject({
  schema: z.literal('mandate/v0.1'),
  id: IdSchema,
  version: z.number().int().min(1).max(0xffffffff),
  status: z.enum(['active', 'revoked']),
  principal: z.strictObject({ type: z.literal('organization'), id: IdSchema, name: z.string().min(1).max(128) }),
  delegate: z.strictObject({ type: z.literal('agent'), id: IdSchema, public_key: Ed25519Key }),
  approvers: z.array(z.strictObject({ role: z.string().min(1).max(32), cardano_key_hash: hexBytes(28) })).min(1),
  authority_engine: z.strictObject({ public_key: Ed25519Key }),
  asset: z.strictObject({ symbol: AssetSymbol, decimals: z.number().int().min(0).max(18) }),
  validity: z.strictObject({ starts_at: z.iso.datetime(), expires_at: z.iso.datetime() }),
  delegation: z.strictObject({ allowed: z.literal(false) }),
  constraints: z.array(ConstraintSchema).min(1),
});

export const ActionTypeSchema = z.enum(['pay_invoice', 'purchase', 'transfer']);

export const ActionIRSchema = z.strictObject({
  schema: z.literal('action-ir/v0.1'),
  id: IdSchema,
  mandate_id: IdSchema,
  actor: IdSchema,
  type: ActionTypeSchema,
  purpose: IdSchema,
  counterparty: z.strictObject({ id: IdSchema, display: z.string().min(1).max(128) }),
  amount: z.strictObject({ value: PositiveUnits, asset: AssetSymbol }),
  recipient: z.strictObject({
    chain: z.literal('cardano'),
    address: z
      .string()
      .max(200)
      .refine((address) => {
        try {
          parseShelleyAddress(address);
          return true;
        } catch {
          return false;
        }
      }, 'invalid Shelley address'),
  }),
  source: z.strictObject({ vault: IdSchema }),
  reference: z
    .strictObject({ invoice_id: z.string().min(1).max(64), invoice_number: z.string().min(1).max(64) })
    .optional(),
  rationale: z.string().max(2000),
  created_at: z.iso.datetime(),
});

export const StateSchema = z.strictObject({
  vault_balance: Units,
  spent_today: Units,
  day_index: z.number().int().min(0),
  last_nonce: Units,
  anchor_version: z.number().int().min(1),
  anchor_status: z.enum(['active', 'revoked']),
  observed_at_slot: z.number().int().min(0),
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
]);

export type Mandate = z.infer<typeof MandateSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type ActionIR = z.infer<typeof ActionIRSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type State = z.infer<typeof StateSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;
export type Outcome = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
export interface VerifiedReport {
  report: VerificationReport;
  report_hash: string;
  block_time_ms: number;
}
