import { createHmac, timingSafeEqual } from 'node:crypto';

// Webhook signing (reference 4.1, 4.2, 12). Outbound (Crebit -> us): HMAC-SHA256 over `${t}.${raw body bytes}`.
// Inbound (us -> Crebit): HMAC-SHA256 over `${t}.${canonical JSON}` with keys sorted, no whitespace, nulls dropped.

export const SIGNATURE_SKEW_S = 300;

/** Canonical JSON for inbound signing: sorted keys recursively, no whitespace, null fields dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const hmac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex');

/** Verifies `X-Crebit-Signature: t=<unix>,v1=<hex>` against the raw body. Rejects a timestamp more than 300 s from now. */
export function verifyWebhook(rawBody: string | Uint8Array, signatureHeader: string | undefined, secret: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/i.exec(signatureHeader ?? '');
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(nowS - ts) > SIGNATURE_SKEW_S) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const expected = createHmac('sha256', secret).update(`${ts}.`).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(m[2]!.toLowerCase(), 'hex'));
}

/** Headers for an inbound webhook body (funds_in_route, contract_exercised). */
export function signInbound(body: unknown, secret: string, nowS = Math.floor(Date.now() / 1000)): { 'X-Crebit-Signature': string; 'X-Crebit-Timestamp': string } {
  const v1 = hmac(secret, `${nowS}.${canonicalJson(body)}`);
  return { 'X-Crebit-Signature': `t=${nowS},v1=${v1}`, 'X-Crebit-Timestamp': String(nowS) };
}
