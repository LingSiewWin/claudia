import type { ActionIR, ReasonCode } from '@authority/core';

/** Base units -> display string with at least 2 decimals ("8.42", "18.00", "0.000001"). */
export function formatUnits(value: string | bigint, decimals = 6): string {
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) throw new Error('Not a base-unit amount');
  const v = BigInt(value);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${sign}${whole}.${frac}`;
}

/** Display string -> base units. Throws on anything that is not a plain non-negative decimal. */
export function parseUnits(text: string, decimals = 6): bigint {
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error('Enter an amount like 10 or 8.42');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimals`);
  return BigInt(m[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/**
 * Base units -> "$8.42", "$8,420.00"; `whole` drops a ".00" ("$10", "$0").
 * Every amount on screen goes through here: the UI shows the amounts the chain and Stripe hold.
 */
export function money(value: string | bigint, decimals = 6, whole = false): string {
  const text = formatUnits(value, decimals);
  const sign = text.startsWith('-') ? '-' : '';
  const [int = '0', frac = '00'] = text.replace('-', '').split('.');
  return `${sign}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${whole && frac === '00' ? '' : `.${frac}`}`;
}

/** The business object an action is about: "AWS invoice", "NFT marketplace purchase". */
export function actionTitle(a: Pick<ActionIR, 'type'> & { counterparty: Pick<ActionIR['counterparty'], 'display'> }): string {
  const vendor = a.counterparty.display.replace(/\s*\(demo vendor\)$/, '');
  if (a.type === 'pay_invoice') return `${vendor} invoice`;
  if (a.type === 'purchase') return `${vendor} purchase`;
  return `Transfer to ${vendor}`;
}

export const shortHex = (hex: string, head = 8, tail = 6) =>
  hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;

/** "2026-10-07T03:41:02.123Z" -> "03:41:02 UTC". Deterministic on server and client. */
export const clock = (iso: string) => `${iso.slice(11, 19)} UTC`;

export const REASON_TEXT: Record<ReasonCode, string> = {
  INVALID_PROPOSAL: 'The proposal is malformed.',
  INVALID_AGENT_SIGNATURE: "The agent's signature does not match its registered key.",
  AGENT_NOT_DELEGATE: 'This agent is not the delegate named in the mandate.',
  WRONG_MANDATE: 'The proposal names a different mandate.',
  MANDATE_REVOKED: 'The mandate has been revoked.',
  MANDATE_VERSION_MISMATCH: 'The mandate changed version since this was proposed.',
  MANDATE_NOT_STARTED: 'The mandate is not active yet.',
  MANDATE_EXPIRED: 'The mandate has expired.',
  PURPOSE_NOT_AUTHORIZED: 'The purpose is outside the mandate.',
  ACTION_NOT_AUTHORIZED: 'This kind of action is outside the mandate.',
  ASSET_NOT_AUTHORIZED: 'The mandate does not allow this asset.',
  AMOUNT_ABOVE_HARD_CAP: 'The amount is above the hard cap. Nobody can approve it.',
  DAILY_CAP_EXCEEDED: "This payment would exceed today's spending cap.",
  TREASURY_FLOOR_VIOLATION: 'The treasury would fall below its minimum balance.',
  INVOICE_NOT_FOUND: 'The invoice does not exist at the billing source.',
  INVOICE_NOT_OPEN: 'The invoice is not open (already paid or void).',
  CUSTOMER_MISMATCH: 'The invoice is not addressed to Acme Corp.',
  AMOUNT_MISMATCH: 'The amount differs from the invoice.',
  CURRENCY_MISMATCH: 'The currency differs from the invoice.',
  RECIPIENT_MISMATCH: "The recipient is not the vendor's payout address on record.",
  VERIFICATION_UNAVAILABLE: 'The invoice could not be verified right now.',
  COUNTERPARTY_NOT_APPROVED: 'This vendor is not on the approved list.',
  ABOVE_AUTONOMOUS_LIMIT: "The amount is above the agent's autonomous limit.",
  INTERRUPT_BUDGET_EXHAUSTED: "The agent has used today's interrupt budget. Nobody was paged.",
  PRINCIPAL_DECLINED: 'The CFO declined this payment.',
};

export const INVARIANT_TEXT: Record<string, string> = {
  R0: 'Only the canonical vault output can release funds.',
  R1: 'One vault input per transaction.',
  R2: 'The mandate anchor read by the vault must be authentic.',
  R3: 'The mandate is revoked on-chain.',
  R4: 'The authorization was signed for an older mandate version.',
  R5: 'The authorization belongs to a different vault or network.',
  R6: 'The engine signature does not cover these exact terms.',
  R7: 'The authorization has expired.',
  R8: 'This authorization was already used (replay).',
  R9: 'Wrong asset or action type.',
  R10: 'The amount is above the hard cap.',
  R11: 'The CFO did not co-sign a payment above the autonomous limit.',
  R12: "The payment would exceed today's spending cap.",
  R13: 'The vault state was not carried forward correctly.',
  R14: 'The transaction tried to take more than the authorized amount.',
  R15: 'The treasury would fall below its minimum balance.',
  R16: 'The authorized recipient is not paid.',
};

export function plainReason(code: string): string {
  if (Object.hasOwn(REASON_TEXT, code)) return (REASON_TEXT as Record<string, string>)[code] as string;
  return Object.hasOwn(INVARIANT_TEXT, code) ? (INVARIANT_TEXT[code] as string) : code;
}
