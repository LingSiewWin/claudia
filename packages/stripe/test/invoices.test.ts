import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { centsToUsdmUnits, getInvoice, listOpenInvoices, readOnlyStripe, toSummary } from '../src/invoices';
import { fakeStripe, invoiceJson, list, notFound } from './fake-stripe';

const AWS = 'addr_test1vzs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggfw5wvl';

describe('centsToUsdmUnits', () => {
  it('converts cents to USDM base units (x 10_000)', () => {
    expect(centsToUsdmUnits(842)).toBe(8_420_000n);
    expect(centsToUsdmUnits(1800)).toBe(18_000_000n);
    expect(centsToUsdmUnits(50)).toBe(500_000n);
    expect(centsToUsdmUnits(0)).toBe(0n);
  });
  it.each([-1, 1.5, Number.NaN, 2 ** 53])('rejects %s', (cents) => {
    expect(() => centsToUsdmUnits(cents)).toThrow(RangeError);
  });
});

describe('toSummary', () => {
  it('maps the fields the agent and verifier read', () => {
    expect(toSummary(invoiceJson() as unknown as Stripe.Invoice)).toEqual({
      id: 'in_1UNc2MEFJlYN23C9cgaO3eOu',
      number: 'INV-3821',
      customer: 'cus_acme',
      status: 'open',
      vendor_id: 'aws',
      vendor_name: 'AWS (demo vendor)',
      amount_due_cents: 842,
      amount_usdm: '8420000',
      currency: 'usd',
      due_date: '2026-11-05T17:20:22.000Z',
      memo: 'Cloud compute, September',
      payout_chain: 'cardano-preprod',
      payout_address: AWS,
      cardano_tx_hash: null,
    });
  });
  it('maps missing metadata to null, never to a default', () => {
    const s = toSummary(invoiceJson({ metadata: {}, due_date: null, description: null }) as unknown as Stripe.Invoice);
    expect(s).toMatchObject({ number: null, vendor_id: null, payout_address: null, payout_chain: null, due_date: null, memo: null });
  });
  it('accepts an expanded customer object', () => {
    const s = toSummary(invoiceJson({ customer: { id: 'cus_acme', object: 'customer' } }) as unknown as Stripe.Invoice);
    expect(s.customer).toBe('cus_acme');
  });
});

describe('readOnlyStripe', () => {
  it('accepts only a test-mode restricted key', () => {
    expect(() => readOnlyStripe('rk_test_x')).not.toThrow();
  });
  it.each([
    ['vendor secret key in the read slot', 'sk_test_x'],
    ['live restricted key', 'rk_live_x'],
    ['missing', undefined],
  ])('refuses %s', (_label, key) => {
    expect(() => readOnlyStripe(key)).toThrow(/rk_test_/);
  });
});

describe('listOpenInvoices', () => {
  it('asks only for open invoices of one customer and follows pagination', async () => {
    const second = invoiceJson({ id: 'in_second', metadata: { invoice_number: 'INV-3822' } });
    const { stripe, calls } = fakeStripe((req) =>
      req.query.get('starting_after') ? list([second]) : list([invoiceJson()], true),
    );
    const result = await listOpenInvoices(stripe, 'cus_acme');
    expect(result.map((i) => i.number)).toEqual(['INV-3821', 'INV-3822']);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.method).toBe('GET');
      expect(c.path).toBe('/v1/invoices');
      expect(c.query.get('customer')).toBe('cus_acme');
      expect(c.query.get('status')).toBe('open');
    }
    expect(calls[1]?.query.get('starting_after')).toBe('in_1UNc2MEFJlYN23C9cgaO3eOu');
  });
});

describe('listOpenInvoices id validation', () => {
  it.each(['', undefined as unknown as string, 'acme'])('rejects customer id %j before any request', async (id) => {
    const { stripe, calls } = fakeStripe(() => ({ json: list([]) }));
    await expect(listOpenInvoices(stripe, id)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe('getInvoice', () => {
  it('returns the summary', async () => {
    const { stripe, calls } = fakeStripe(() => ({ json: invoiceJson({ status: 'paid' }) }));
    expect((await getInvoice(stripe, 'in_1UNc2MEFJlYN23C9cgaO3eOu'))?.status).toBe('paid');
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v1/invoices/in_1UNc2MEFJlYN23C9cgaO3eOu' });
  });
  it('returns null when Stripe says the invoice does not exist', async () => {
    const { stripe } = fakeStripe(() => notFound);
    expect(await getInvoice(stripe, 'in_missing')).toBeNull();
  });
  it('throws on an outage instead of reporting "not found"', async () => {
    const { stripe } = fakeStripe(() => ({ status: 500, json: { error: { type: 'api_error', message: 'boom' } } }));
    await expect(getInvoice(stripe, 'in_x')).rejects.toThrow();
  });
  it('throws on a permission error instead of reporting "not found"', async () => {
    const { stripe } = fakeStripe(() => ({ status: 403, json: { error: { type: 'invalid_request_error', code: 'more_permissions_required', message: 'no' } } }));
    await expect(getInvoice(stripe, 'in_x')).rejects.toThrow();
  });
  it.each(['', 'cus_123', 'in_x/../../customers', 'in_' + 'a'.repeat(62)])('rejects malformed id %j before any request', async (id) => {
    const { stripe, calls } = fakeStripe(() => ({ json: invoiceJson() }));
    await expect(getInvoice(stripe, id)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});
