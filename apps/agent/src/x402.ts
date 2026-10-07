import * as z from 'zod';

// x402 over HTTP (coinbase/x402 transports-v2): a 402 carries PAYMENT-REQUIRED, the retry carries PAYMENT-SIGNATURE,
// the 200 carries PAYMENT-RESPONSE. All three are base64 JSON.

export const PaymentRequirementsSchema = z.looseObject({
  scheme: z.string(),
  network: z.string(),
  amount: z.string().regex(/^[0-9]+$/),
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.unknown(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const PaymentRequiredSchema = z.looseObject({
  x402Version: z.number().int(),
  error: z.string().optional(),
  accepts: z.array(PaymentRequirementsSchema).min(1),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

export interface BondRef {
  tx_hash: string;
  output_index: number;
}

export interface PaymentPayload {
  x402Version: 2;
  accepted: PaymentRequirements;
  payload: { approval_id: string } & BondRef;
}

export const PaymentResponseSchema = z.looseObject({ success: z.boolean(), network: z.string(), transaction: z.string() });
export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;

export const b64json = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const fromB64 = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

/** PAYMENT-REQUIRED header (base64 JSON); the body of the 402 is the same document and the fallback. */
export function decodePaymentRequired(header: string | null, body: unknown): PaymentRequired | null {
  const raw = header ? fromB64(header) : body;
  const parsed = PaymentRequiredSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function decodePaymentResponse(header: string | null): PaymentResponse | null {
  if (!header) return null;
  const parsed = PaymentResponseSchema.safeParse(fromB64(header));
  return parsed.success ? parsed.data : null;
}
