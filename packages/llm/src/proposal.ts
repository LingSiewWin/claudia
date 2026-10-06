import { type ActionIR, ActionIRSchema, type Mandate } from '@authority/core';
import * as z from 'zod';
import type { ToolDef } from './model';

// The structured surface the model fills in. The runtime, never the model, adds identity (mandate, actor),
// asset, base units, timestamps, and the signature.

const Decimal = z.string().regex(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/);
const Slug = z.string().regex(/^[a-z0-9_-]{1,64}$/);

export const ProposeArgsSchema = z.strictObject({
  type: z.enum(['pay_invoice', 'purchase', 'transfer']).describe('pay_invoice for a vendor invoice, purchase for buying something, transfer otherwise'),
  purpose: Slug.describe('Business purpose in snake_case, for example invoice_payment'),
  counterparty_id: Slug.describe('Vendor id exactly as on the invoice (vendor_id), for example aws'),
  counterparty_display: z.string().min(1).max(128).describe('Vendor display name'),
  amount: Decimal.describe('Amount in USDM as a decimal string with at most 6 decimals, for example "8.42"'),
  recipient_address: z
    .string()
    .regex(/^addr(_test)?1[0-9a-z]{20,200}$/)
    .describe('Cardano address that receives the payment'),
  invoice: z
    .strictObject({
      invoice_id: z.string().regex(/^in_[A-Za-z0-9]{1,61}$/).describe('Stripe invoice id (in_...)'),
      invoice_number: z.string().min(1).max(64).describe('Invoice number, for example INV-3821'),
    })
    .optional()
    .describe('Required for pay_invoice'),
  rationale: z.string().min(1).max(2000).describe('Why this payment should be made, in one or two sentences'),
});
export type ProposeArgs = z.infer<typeof ProposeArgsSchema>;

export class ProposalArgsError extends Error {
  override name = 'ProposalArgsError';
}

export function decimalToUnits(value: string, decimals: number): string {
  if (!Decimal.safeParse(value).success) throw new ProposalArgsError(`amount must be a decimal string, got ${JSON.stringify(value)}`);
  const [whole, frac = ''] = value.split('.') as [string, string?];
  if (frac.length > decimals) throw new ProposalArgsError(`amount has more than ${decimals} decimals`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}

export function unitsToDecimal(units: string, decimals: number): string {
  const v = BigInt(units);
  if (decimals === 0) return v.toString();
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${v / base}.${frac}` : (v / base).toString();
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');

export interface ActionContext {
  id: string;
  mandate: Pick<Mandate, 'id' | 'delegate' | 'asset'>;
  sourceVault: string;
  nowIso: string;
}

/** Model arguments -> strict Action IR. Throws ProposalArgsError with a message the model can act on. */
export function buildAction(raw: unknown, ctx: ActionContext): ActionIR {
  const parsed = ProposeArgsSchema.safeParse(raw);
  if (!parsed.success) throw new ProposalArgsError(`invalid input: ${issues(parsed.error)}`);
  const a = parsed.data;
  if (a.type === 'pay_invoice' && !a.invoice) throw new ProposalArgsError('pay_invoice needs invoice { invoice_id, invoice_number }');
  const checked = ActionIRSchema.safeParse({
    schema: 'action-ir/v0.1',
    id: ctx.id,
    mandate_id: ctx.mandate.id,
    actor: ctx.mandate.delegate.id,
    type: a.type,
    purpose: a.purpose,
    counterparty: { id: a.counterparty_id, display: a.counterparty_display },
    amount: { value: decimalToUnits(a.amount, ctx.mandate.asset.decimals), asset: ctx.mandate.asset.symbol },
    recipient: { chain: 'cardano', address: a.recipient_address },
    source: { vault: ctx.sourceVault },
    ...(a.invoice ? { reference: { invoice_id: a.invoice.invoice_id, invoice_number: a.invoice.invoice_number } } : {}),
    rationale: a.rationale,
    created_at: ctx.nowIso,
  });
  if (!checked.success) throw new ProposalArgsError(`not a valid action: ${issues(checked.error)}`);
  return checked.data;
}

/** JSON Schema for a tool input (draft 2020-12, additionalProperties false), without the $schema key. */
export function toolSchema(schema: z.ZodType): ToolDef['input_schema'] {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
  return rest as ToolDef['input_schema'];
}

export const PROPOSE_TOOL_SCHEMA = toolSchema(ProposeArgsSchema);

export const NoArgsSchema = z.strictObject({});

/** Display label of the vault a mandate pays from (the Action IR source field). */
export const sourceVaultFor = (mandateId: string) => (mandateId === 'M-LAB' ? 'acme-lab' : 'acme-treasury');
