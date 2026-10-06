import { canonicalJson, VerificationReportSchema } from '@authority/core';
import { describe, expect, it } from 'vitest';
import { buildReport, normalizeInvoice, type TriggerRequest, TriggerRequestSchema } from '../src/verify';

const PAYOUT = 'addr_test1qpe3z9srjllzq27zndk5nxlcrxs8u6tr3lvs00xk3pcauwend7e3wv3tk360w5k3uz2nkneydscpuwp9t2uwggpsfzgsgehreu';
const ATTACKER = 'addr_test1vzattackerattackerattackerattackerattackerattackerattackerq';

const invoice = (overrides: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({
  id: 'in_1QxDemoAws0001',
  object: 'invoice',
  customer: 'cus_AcmeDemo0001',
  status: 'open',
  amount_due: 842,
  currency: 'usd',
  created: 1_791_300_000,
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/test_y',
  lines: { object: 'list', data: [] },
  metadata: { vendor_id: 'aws', payout_chain: 'cardano-preprod', payout_address: PAYOUT, ...metadata },
  ...overrides,
});

const request = (overrides: Partial<TriggerRequest> = {}): TriggerRequest => ({
  trigger_id: '6f1c2a9e-7b1d-4c52-9a35-2f4f5d0c9b11',
  action_hash: 'ab'.repeat(32),
  invoice_id: 'in_1QxDemoAws0001',
  customer_id: 'cus_AcmeDemo0001',
  requested_amount: '8420000',
  requested_currency: 'usd',
  requested_recipient: PAYOUT,
  ...overrides,
});

const report = (status: number, body: unknown, req: TriggerRequest = request()) =>
  buildReport(normalizeInvoice(status, body), req).report;

describe('buildReport (each fact compared exactly)', () => {
  it('verifies a matching open invoice and converts cents to USDM units', () => {
    const r = report(200, invoice());
    expect(r.result).toBe('VERIFIED');
    expect(r.reason).toBeNull();
    expect(r.verified_amount).toBe('8420000');
    expect(r.verified_recipient).toBe(PAYOUT);
    expect(r.status).toBe('open');
    expect(VerificationReportSchema.safeParse(r).success).toBe(true);
  });

  it.each([
    ['invoice missing (404)', 404, { error: { code: 'resource_missing' } }, {}, 'INVOICE_NOT_FOUND', 'exists'],
    ['Stripe returned another invoice id', 200, invoice({ id: 'in_1QxOther0002' }), {}, 'INVOICE_NOT_FOUND', 'exists'],
    ['issued to another customer', 200, invoice({ customer: 'cus_SomeoneElse01' }), {}, 'CUSTOMER_MISMATCH', 'customer_match'],
    ['already paid', 200, invoice({ status: 'paid' }), {}, 'INVOICE_NOT_OPEN', 'status_open'],
    ['amount differs by one cent', 200, invoice({ amount_due: 843 }), {}, 'AMOUNT_MISMATCH', 'amount_match'],
    ['amount differs by one base unit', 200, invoice(), { requested_amount: '8420001' }, 'AMOUNT_MISMATCH', 'amount_match'],
    ['currency differs', 200, invoice({ currency: 'eur' }), {}, 'CURRENCY_MISMATCH', 'currency_match'],
    ['agent proposes its own recipient', 200, invoice(), { requested_recipient: ATTACKER }, 'RECIPIENT_MISMATCH', 'recipient_match'],
    ['payout chain is not cardano-preprod', 200, invoice({}, { payout_chain: 'ethereum' }), {}, 'RECIPIENT_MISMATCH', 'recipient_match'],
    ['payout address missing', 200, invoice({}, { payout_address: undefined }), {}, 'RECIPIENT_MISMATCH', 'recipient_match'],
  ] as const)('%s -> %s', (_label, status, body, req, reason, fact) => {
    const r = report(status, body, request(req));
    expect(r.result).toBe('MISMATCH');
    expect(r.reason).toBe(reason);
    expect(r.facts[fact]).toBe(false);
    expect(VerificationReportSchema.safeParse(r).success).toBe(true);
  });

  it.each([
    ['customer', { customer: null }, { customer_id: null }, 'CUSTOMER_MISMATCH', 'customer_match'],
    ['recipient', { payout_address: null }, { requested_recipient: null }, 'RECIPIENT_MISMATCH', 'recipient_match'],
  ] as const)('never matches a null %s against a null request field', (_label, tuple, patch, reason, fact) => {
    const t = { ...normalizeInvoice(200, invoice()), ...tuple };
    const r = buildReport(t, { ...request(), ...patch } as unknown as TriggerRequest).report;
    expect(r.facts[fact]).toBe(false);
    expect(r.result).toBe('MISMATCH');
    expect(r.reason).toBe(reason);
  });

  it('reports an amount whose USDM value overflows u64 as unverified, not as a match', () => {
    const r = report(200, invoice({ amount_due: 2_000_000_000_000_000 }));
    expect(r.verified_amount).toBeNull();
    expect(r.facts.amount_match).toBe(false);
    expect(r.result).toBe('MISMATCH');
    expect(r.reason).toBe('AMOUNT_MISMATCH');
    expect(VerificationReportSchema.safeParse(r).success).toBe(true);
  });

  it('reports the first failing fact in spec order', () => {
    const r = report(200, invoice({ status: 'paid' }), request({ requested_recipient: ATTACKER }));
    expect(r.facts.recipient_match).toBe(false);
    expect(r.reason).toBe('INVOICE_NOT_OPEN');
  });

  it.each([401, 403, 429, 500, 503])('treats HTTP %i as unavailable, never as a fact', (status) => {
    expect(() => normalizeInvoice(status, {})).toThrow(`stripe: unexpected HTTP ${status}`);
  });

  it.each([
    ['path traversal in invoice id', { invoice_id: 'in_x/../../balance' }],
    ['query injection in invoice id', { invoice_id: 'in_x?expand=customer' }],
    ['non-invoice id', { invoice_id: 'cus_AcmeDemo0001' }],
    ['uppercase action hash', { action_hash: 'AB'.repeat(32) }],
    ['fractional amount', { requested_amount: '8.42' }],
    ['negative amount', { requested_amount: '-1' }],
    ['amount with leading zero', { requested_amount: '08420000' }],
    ['amount 2^64', { requested_amount: '18446744073709551616' }],
    ['uppercase currency', { requested_currency: 'USD' }],
    ['unknown field', { extra: 1 }],
  ])('rejects trigger payload: %s', (_label, patch) => {
    expect(TriggerRequestSchema.safeParse({ ...request(), ...patch }).success).toBe(false);
  });
});

describe('normalizeInvoice (deterministic, no node-local data)', () => {
  it('normalizes the same response to byte-identical output', () => {
    expect(canonicalJson(normalizeInvoice(200, invoice()))).toBe(canonicalJson(normalizeInvoice(200, invoice())));
    expect(buildReport(normalizeInvoice(200, invoice()), request()).report_hash).toBe(
      buildReport(normalizeInvoice(200, invoice()), request()).report_hash,
    );
  });

  it('ignores key order and volatile fields', () => {
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(invoice()).reverse())));
    const volatile = invoice({ created: 1, hosted_invoice_url: 'https://other', lines: { data: [1, 2] }, next_payment_attempt: 5 });
    const base = canonicalJson(normalizeInvoice(200, invoice()));
    expect(canonicalJson(normalizeInvoice(200, reordered))).toBe(base);
    expect(canonicalJson(normalizeInvoice(200, volatile))).toBe(base);
  });

  it('keeps exactly the seven spec fields', () => {
    expect(Object.keys(normalizeInvoice(200, invoice())).sort()).toEqual([
      'amount_due',
      'currency',
      'customer',
      'id',
      'payout_address',
      'status',
      'vendor_id',
    ]);
  });

  it('maps missing or malformed fields to explicit null', () => {
    const t = normalizeInvoice(
      200,
      invoice({ customer: { id: 'cus_AcmeDemo0001' }, status: 7, amount_due: 8.42, currency: 'USD', metadata: ['x'] }),
    );
    expect(t).toEqual({
      id: 'in_1QxDemoAws0001',
      customer: null,
      status: null,
      amount_due: null,
      currency: null,
      payout_address: null,
      vendor_id: null,
    });
    expect(normalizeInvoice(404, null)).toEqual({ ...t, id: null });
    expect(report(200, invoice({ amount_due: '842' })).verified_amount).toBeNull();
  });
});
