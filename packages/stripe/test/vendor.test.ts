import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
  DEMO_INVOICES,
  type DemoInvoice,
  invoiceMetadata,
  markPaidOutOfBand,
  planSeed,
  seedInvoices,
  vendorAddressesFromEnv,
  vendorStripe,
} from '../src/vendor';
import { type FakeRequest, fakeStripe, invoiceJson, list } from './fake-stripe';

const AWS = 'addr_test1vzs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggfw5wvl';
const AWS_NEW = 'addr_test1vz329g4z52329g4z52329g4z52329g4z52329g4z52329gs6qg6tn';
const GLOBEX = 'addr_test1vzet9v4jk2et9v4jk2et9v4jk2et9v4jk2et9v4jk2et9vspneuyz';
const MAINNET = 'addr1vxs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggjxqjr6';
const ADDRS = { aws: AWS, globex: GLOBEX };
const TX = 'ab'.repeat(32);

const byNumber = (n: string) => DEMO_INVOICES.find((i) => i.number === n) as DemoInvoice;
// An existing Stripe invoice exactly as seed would have created it.
const existing = (n: string, overrides: Record<string, unknown> = {}, address = AWS) => {
  const d = byNumber(n);
  return invoiceJson({ id: `in_${n.replaceAll('-', '')}`, amount_due: d.cents, metadata: invoiceMetadata(d, address), ...overrides }) as unknown as Stripe.Invoice;
};

describe('DEMO_INVOICES', () => {
  it('pins the demo invoices and amounts (cents)', () => {
    expect(DEMO_INVOICES.map((i) => [i.number, i.set, i.vendor, i.cents])).toEqual([
      ['INV-3821', 'stage', 'aws', 842],
      ['INV-3822', 'stage', 'aws', 1800],
      ['INV-G-0042', 'stage', 'globex', 500],
      ['INV-3825', 'stage', 'aws', 6000],
      ['INV-3823', 'stage', 'aws', 400],
      ['INV-3824', 'stage', 'aws', 900],
      ['INV-M-0001', 'masumi', 'aws', 842],
      ['INV-M-0002', 'masumi', 'aws', 1800],
      ['INV-M-0003', 'masumi', 'aws', 400],
      ['INV-L-0001', 'lab', 'aws', 50],
      ['INV-L-0002', 'lab', 'aws', 50],
      ['INV-L-0003', 'lab', 'aws', 50],
      ['INV-L-0004', 'lab', 'aws', 50],
      ['INV-L-0005', 'lab', 'aws', 50],
      ['INV-L-0006', 'lab', 'aws', 50],
      ['INV-L-0021', 'lab', 'globex', 50],
      ['INV-L-0022', 'lab', 'globex', 50],
      ['INV-L-0023', 'lab', 'globex', 50],
      ['INV-L-0024', 'lab', 'globex', 50],
    ]);
    expect(new Set(DEMO_INVOICES.map((i) => i.number)).size).toBe(DEMO_INVOICES.length);
  });
});

describe('invoiceMetadata', () => {
  it('carries the vendor-set payout destination', () => {
    expect(invoiceMetadata(byNumber('INV-G-0042'), GLOBEX)).toEqual({
      invoice_number: 'INV-G-0042',
      demo_set: 'stage',
      vendor_id: 'globex',
      vendor_name: 'Globex (demo vendor)',
      payout_chain: 'cardano-preprod',
      payout_address: GLOBEX,
    });
  });
});

describe('vendorAddressesFromEnv', () => {
  it('reads both preprod addresses', () => {
    expect(vendorAddressesFromEnv({ DEMO_VENDOR_AWS_ADDRESS: AWS, DEMO_VENDOR_GLOBEX_ADDRESS: GLOBEX })).toEqual(ADDRS);
  });
  it.each([
    ['missing', { DEMO_VENDOR_GLOBEX_ADDRESS: GLOBEX }, /DEMO_VENDOR_AWS_ADDRESS is not set/],
    ['mainnet', { DEMO_VENDOR_AWS_ADDRESS: MAINNET, DEMO_VENDOR_GLOBEX_ADDRESS: GLOBEX }, /preprod/],
    ['garbage', { DEMO_VENDOR_AWS_ADDRESS: AWS, DEMO_VENDOR_GLOBEX_ADDRESS: 'addr_test1nope' }, /address/],
  ])('rejects %s', (_label, env, message) => {
    expect(() => vendorAddressesFromEnv(env)).toThrow(message);
  });
});

describe('vendorStripe', () => {
  it.each([['rk_test_x'], ['sk_live_x'], [undefined]])('refuses %s', (key) => {
    expect(() => vendorStripe(key)).toThrow(/sk_test_/);
  });
});

describe('planSeed', () => {
  const stage = DEMO_INVOICES.filter((i) => i.set === 'stage');
  const opts = { sets: ['stage'] as const };

  it('creates everything on an empty account', () => {
    const plan = planSeed([], stage, ADDRS, opts);
    expect(plan.create.map((i) => i.number)).toEqual(stage.map((i) => i.number));
    expect(plan).toMatchObject({ keep: [], voidIds: [], deleteIds: [] });
  });

  it('is idempotent: matching open invoices are kept, nothing created', () => {
    const all = stage.map((i) => existing(i.number, {}, i.vendor === 'globex' ? GLOBEX : AWS));
    const plan = planSeed(all, stage, ADDRS, opts);
    expect(plan.keep).toHaveLength(stage.length);
    expect(plan).toMatchObject({ create: [], voidIds: [], deleteIds: [] });
  });

  it('recreates a paid invoice for the next run', () => {
    const plan = planSeed([existing('INV-3821', { status: 'paid' })], [byNumber('INV-3821')], ADDRS, opts);
    expect(plan.create.map((i) => i.number)).toEqual(['INV-3821']);
    expect(plan.voidIds).toEqual([]);
  });

  it('voids and recreates when the vendor payout address changed', () => {
    const plan = planSeed([existing('INV-3821')], [byNumber('INV-3821')], { ...ADDRS, aws: AWS_NEW }, opts);
    expect(plan.voidIds).toEqual(['in_INV3821']);
    expect(plan.create.map((i) => i.number)).toEqual(['INV-3821']);
  });

  it('voids and recreates when the amount differs', () => {
    const plan = planSeed([existing('INV-3821', { amount_due: 843 })], [byNumber('INV-3821')], ADDRS, opts);
    expect(plan.voidIds).toEqual(['in_INV3821']);
  });

  it('keeps one of two duplicates and voids the other', () => {
    const plan = planSeed([existing('INV-3821'), existing('INV-3821', { id: 'in_dup' })], [byNumber('INV-3821')], ADDRS, opts);
    expect(plan.keep.map((i) => i.id)).toEqual(['in_INV3821']);
    expect(plan.voidIds).toEqual(['in_dup']);
    expect(plan.create).toEqual([]);
  });

  it('deletes leftover drafts in scope', () => {
    const plan = planSeed([existing('INV-3821', { status: 'draft' })], [byNumber('INV-3821')], ADDRS, opts);
    expect(plan.deleteIds).toEqual(['in_INV3821']);
    expect(plan.create.map((i) => i.number)).toEqual(['INV-3821']);
  });

  it('leaves other sets and foreign invoices alone', () => {
    const lab = existing('INV-L-0001');
    const foreign = invoiceJson({ id: 'in_foreign', metadata: {} }) as unknown as Stripe.Invoice;
    const plan = planSeed([lab, foreign], stage, ADDRS, opts);
    expect(plan).toMatchObject({ keep: [], voidIds: [], deleteIds: [] });
  });

  it('voids an open demo invoice that is no longer in the catalog', () => {
    const retired = existing('INV-3824', { id: 'in_retired', metadata: { ...invoiceMetadata(byNumber('INV-3824'), AWS), invoice_number: 'INV-3999' } });
    const plan = planSeed([retired], stage, ADDRS, opts);
    expect(plan.voidIds).toEqual(['in_retired']);
  });

  it('only creates invoices from the requested sets', () => {
    const plan = planSeed([], DEMO_INVOICES, ADDRS, opts);
    expect(plan.create.length).toBeGreaterThan(0);
    expect(plan.create.every((i) => i.set === 'stage')).toBe(true);
  });

  it('reset voids every open invoice in scope and recreates all', () => {
    const plan = planSeed([existing('INV-3821'), existing('INV-3824')], stage, ADDRS, { ...opts, reset: true });
    expect(plan.voidIds).toEqual(['in_INV3821', 'in_INV3824']);
    expect(plan.keep).toEqual([]);
    expect(plan.create).toHaveLength(stage.length);
  });
});

describe('seedInvoices (I/O against a fake Stripe)', () => {
  it.each(['', 'acme'])('rejects customer id %j before any request', async (customerId) => {
    const { stripe, calls } = fakeStripe(() => list([]));
    await expect(seedInvoices(stripe, { customerId, invoices: DEMO_INVOICES, addresses: ADDRS, sets: ['stage'] })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('creates, adds the exact amount, finalizes, and checks the result', async () => {
    const inv = byNumber('INV-3821');
    const { stripe, calls } = fakeStripe((req) => {
      if (req.method === 'GET') return list([]);
      if (req.path === '/v1/invoices') return { json: invoiceJson({ id: 'in_new', status: 'draft', amount_due: 0 }) };
      if (req.path === '/v1/invoiceitems') return { json: { id: 'ii_1', object: 'invoiceitem' } };
      if (req.path === '/v1/invoices/in_new/finalize') return { json: existing('INV-3821', { id: 'in_new' }) };
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
    const result = await seedInvoices(stripe, { customerId: 'cus_acme', invoices: [inv], addresses: ADDRS, sets: ['stage'] });
    expect(result.created.map((i) => [i.id, i.number, i.amount_usdm, i.payout_address])).toEqual([['in_new', 'INV-3821', '8420000', AWS]]);
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes.map((c) => c.path)).toEqual(['/v1/invoices', '/v1/invoiceitems', '/v1/invoices/in_new/finalize']);
    const [create, item, finalize] = writes as [FakeRequest, FakeRequest, FakeRequest];
    expect(Object.fromEntries(create.body)).toMatchObject({
      customer: 'cus_acme',
      currency: 'usd',
      collection_method: 'send_invoice',
      days_until_due: '30',
      auto_advance: 'false',
      'metadata[payout_address]': AWS,
      'metadata[vendor_id]': 'aws',
      'metadata[payout_chain]': 'cardano-preprod',
      'metadata[invoice_number]': 'INV-3821',
    });
    expect(Object.fromEntries(item.body)).toMatchObject({ invoice: 'in_new', amount: '842', currency: 'usd' });
    expect(finalize.body.get('auto_advance')).toBe('false');
  });

  it('fails loudly if Stripe finalizes a different amount', async () => {
    const { stripe } = fakeStripe((req) => {
      if (req.method === 'GET') return list([]);
      if (req.path === '/v1/invoices') return { json: invoiceJson({ id: 'in_new', status: 'draft' }) };
      if (req.path === '/v1/invoiceitems') return { json: { id: 'ii_1', object: 'invoiceitem' } };
      return { json: existing('INV-3821', { id: 'in_new', amount_due: 9999 }) };
    });
    await expect(
      seedInvoices(stripe, { customerId: 'cus_acme', invoices: [byNumber('INV-3821')], addresses: ADDRS, sets: ['stage'] }),
    ).rejects.toThrow(/INV-3821: expected open with 842 cents/);
  });
});

describe('markPaidOutOfBand', () => {
  it('records the tx hash, then marks paid out of band', async () => {
    const { stripe, calls } = fakeStripe((req) =>
      req.path.endsWith('/pay') ? { json: existing('INV-3821', { status: 'paid' }) } : { json: existing('INV-3821') },
    );
    const paid = await markPaidOutOfBand(stripe, 'in_INV3821', TX);
    expect(paid.status).toBe('paid');
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes.map((c) => [c.path, Object.fromEntries(c.body)])).toEqual([
      ['/v1/invoices/in_INV3821', { 'metadata[cardano_tx_hash]': TX }],
      ['/v1/invoices/in_INV3821/pay', { paid_out_of_band: 'true' }],
    ]);
  });

  it('is a no-op retry when already paid with the same hash', async () => {
    const meta = { ...invoiceMetadata(byNumber('INV-3821'), AWS), cardano_tx_hash: TX };
    const { stripe, calls } = fakeStripe(() => ({ json: existing('INV-3821', { status: 'paid', metadata: meta }) }));
    await markPaidOutOfBand(stripe, 'in_INV3821', TX);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('refuses a second settlement of a paid invoice', async () => {
    const meta = { ...invoiceMetadata(byNumber('INV-3821'), AWS), cardano_tx_hash: 'cd'.repeat(32) };
    const { stripe, calls } = fakeStripe(() => ({ json: existing('INV-3821', { status: 'paid', metadata: meta }) }));
    await expect(markPaidOutOfBand(stripe, 'in_INV3821', TX)).rejects.toThrow(/already paid by cdcd/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('refuses to overwrite a different recorded hash on an open invoice', async () => {
    const meta = { ...invoiceMetadata(byNumber('INV-3821'), AWS), cardano_tx_hash: 'cd'.repeat(32) };
    const { stripe, calls } = fakeStripe(() => ({ json: existing('INV-3821', { metadata: meta }) }));
    await expect(markPaidOutOfBand(stripe, 'in_INV3821', TX)).rejects.toThrow(/already records settlement cdcd/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('refuses a void invoice', async () => {
    const { stripe } = fakeStripe(() => ({ json: existing('INV-3821', { status: 'void' }) }));
    await expect(markPaidOutOfBand(stripe, 'in_INV3821', TX)).rejects.toThrow(/is void, not open/);
  });

  it.each(['AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32)])('rejects malformed tx hash %s before any request', async (hash) => {
    const { stripe, calls } = fakeStripe(() => ({ json: existing('INV-3821') }));
    await expect(markPaidOutOfBand(stripe, 'in_INV3821', hash)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});
