import { describe, expect, it } from 'vitest';
import { getInvoice, listOpenInvoices, readOnlyStripe } from '../src/invoices';
import { type DemoInvoice, ensureCustomer, markPaidOutOfBand, seedInvoices, vendorStripe } from '../src/vendor';

// Integration: hits Stripe test mode. Runs only with STRIPE_INTEGRATION=1 and the repo-root .env.
// Uses its own "probe" customer, so the demo customer's invoices are never touched.
const RUN = process.env.STRIPE_INTEGRATION === '1';
if (RUN) process.loadEnvFile(new URL('../../../.env', import.meta.url));

const AWS = 'addr_test1vzs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggfw5wvl';
const AWS_NEW = 'addr_test1vz329g4z52329g4z52329g4z52329g4z52329g4z52329gs6qg6tn';
const GLOBEX = 'addr_test1vzet9v4jk2et9v4jk2et9v4jk2et9v4jk2et9v4jk2et9vspneuyz';
const PROBE: DemoInvoice[] = [
  { number: 'PROBE-A', set: 'stage', vendor: 'aws', cents: 842, memo: 'probe A' },
  { number: 'PROBE-B', set: 'stage', vendor: 'globex', cents: 500, memo: 'probe B' },
];

describe.runIf(RUN)('Stripe test mode (integration)', () => {
  it('seeds, reads with the restricted key, refuses writes, marks paid, resets', { timeout: 180_000 }, async () => {
    const vendor = vendorStripe(process.env.STRIPE_VENDOR_SECRET_KEY);
    const reader = readOnlyStripe(process.env.STRIPE_READ_KEY);
    const customer = await ensureCustomer(vendor, { name: 'probe-Acme Corp', email: 'probe-acme@example.com' });
    const seed = (addresses: { aws: string; globex: string }, reset = false) =>
      seedInvoices(vendor, { customerId: customer.id, invoices: PROBE, addresses, sets: ['stage'], reset });

    // 1. reset to a known state, then seeding again is a no-op
    const first = await seed({ aws: AWS, globex: GLOBEX }, true);
    expect(first.created.map((i) => [i.number, i.status, i.amount_due_cents])).toEqual([
      ['PROBE-A', 'open', 842],
      ['PROBE-B', 'open', 500],
    ]);
    const again = await seed({ aws: AWS, globex: GLOBEX });
    expect(again.created).toEqual([]);
    expect(again.kept.map((i) => i.number).sort()).toEqual(['PROBE-A', 'PROBE-B']);
    console.log('seeded', first.created.map((i) => `${i.number}=${i.id}`).join(' '));

    // 2. the restricted key sees exactly what the vendor published
    const open = await listOpenInvoices(reader, customer.id);
    const a = open.find((i) => i.number === 'PROBE-A');
    expect(a).toMatchObject({
      customer: customer.id,
      status: 'open',
      currency: 'usd',
      amount_due_cents: 842,
      amount_usdm: '8420000',
      vendor_id: 'aws',
      vendor_name: 'AWS (demo vendor)',
      payout_chain: 'cardano-preprod',
      payout_address: AWS,
    });
    expect(await getInvoice(reader, a!.id)).toEqual(a);
    expect(await getInvoice(reader, 'in_doesnotexist000000000')).toBeNull();

    // 3. the restricted key cannot write (agent boundary)
    for (const attempt of [
      () => reader.invoices.update(a!.id, { metadata: { payout_address: 'addr_test1attacker' } }),
      () => reader.invoices.pay(a!.id, { paid_out_of_band: true }),
      () => reader.invoices.create({ customer: customer.id }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ statusCode: 403, code: 'more_permissions_required' });
    }
    console.log('read key write attempts: 403 more_permissions_required x3');

    // 4. vendor changes its payout address: A is voided and reissued, B untouched
    const moved = await seed({ aws: AWS_NEW, globex: GLOBEX });
    expect(moved.voided).toEqual([a!.id]);
    expect(moved.created.map((i) => [i.number, i.payout_address])).toEqual([['PROBE-A', AWS_NEW]]);
    const a2 = moved.created[0]!;

    // 5. settlement marks it paid out of band, with the Cardano tx hash; retries are safe, double settlement refused
    const tx = 'ab'.repeat(32);
    const paid = await markPaidOutOfBand(vendor, a2.id, tx);
    expect(paid.status).toBe('paid');
    expect((await markPaidOutOfBand(vendor, a2.id, tx)).status).toBe('paid');
    await expect(markPaidOutOfBand(vendor, a2.id, 'cd'.repeat(32))).rejects.toThrow(/already paid/);
    const after = await getInvoice(reader, a2.id);
    expect(after).toMatchObject({ status: 'paid', cardano_tx_hash: tx });
    expect((await listOpenInvoices(reader, customer.id)).some((i) => i.id === a2.id)).toBe(false);
    console.log('paid out of band', a2.id, after?.status, after?.cardano_tx_hash);

    // 6. clean up: void every open probe invoice
    const cleaned = await seedInvoices(vendor, { customerId: customer.id, invoices: [], addresses: { aws: AWS, globex: GLOBEX }, sets: ['stage'], reset: true });
    expect(cleaned.created).toEqual([]);
    expect(await listOpenInvoices(reader, customer.id)).toEqual([]);
  });
});
