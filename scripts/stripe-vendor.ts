// Vendor simulator for the demo billing network (Stripe test mode).
// Usage: pnpm --filter @authority/scripts stripe <customer | seed [sets] | reset [sets] | list | mark-paid <in_...> <tx_hash>>
import { type InvoiceSummary, listOpenInvoices, readOnlyStripe } from '@authority/stripe';
import {
  ACME_CUSTOMER,
  DEMO_INVOICES,
  type DemoSet,
  ensureCustomer,
  markPaidOutOfBand,
  seedInvoices,
  vendorAddressesFromEnv,
  vendorStripe,
} from '@authority/stripe/vendor';

process.loadEnvFile(new URL('../.env', import.meta.url));

const ALL_SETS: DemoSet[] = ['stage', 'masumi', 'lab'];
const [command, ...args] = process.argv.slice(2);

function customerId(): string {
  const id = process.env.STRIPE_ACME_CUSTOMER_ID;
  if (!id?.startsWith('cus_')) throw new Error('STRIPE_ACME_CUSTOMER_ID is not set; run the "customer" command first');
  return id;
}

function parseSets(values: string[]): DemoSet[] {
  if (values.length === 0) return ALL_SETS;
  for (const v of values) if (!ALL_SETS.includes(v as DemoSet)) throw new Error(`unknown set "${v}" (expected ${ALL_SETS.join(', ')})`);
  return values as DemoSet[];
}

const usd = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const row = (i: InvoiceSummary) =>
  [i.number, i.id, i.vendor_id, `${usd(i.amount_due_cents)} usd`, `${i.amount_usdm} usdm-units`, i.status, i.payout_address].join('  ');

switch (command) {
  case 'customer': {
    const customer = await ensureCustomer(vendorStripe(process.env.STRIPE_VENDOR_SECRET_KEY), ACME_CUSTOMER);
    console.log(`STRIPE_ACME_CUSTOMER_ID=${customer.id}`);
    break;
  }
  case 'seed':
  case 'reset': {
    const sets = parseSets(args);
    const result = await seedInvoices(vendorStripe(process.env.STRIPE_VENDOR_SECRET_KEY), {
      customerId: customerId(),
      invoices: DEMO_INVOICES.filter((i) => sets.includes(i.set)),
      addresses: vendorAddressesFromEnv(),
      sets,
      reset: command === 'reset',
    });
    console.log(`sets ${sets.join(',')}: kept ${result.kept.length}, created ${result.created.length}, voided ${result.voided.length}, deleted drafts ${result.deleted.length}`);
    for (const i of [...result.kept, ...result.created]) console.log(row(i));
    break;
  }
  case 'list': {
    const open = await listOpenInvoices(readOnlyStripe(process.env.STRIPE_READ_KEY), customerId());
    console.log(`open invoices for ${customerId()} (read with the restricted key): ${open.length}`);
    for (const i of open) console.log(row(i));
    break;
  }
  case 'mark-paid': {
    const [invoiceId, txHash] = args;
    if (!invoiceId || !txHash) throw new Error('usage: mark-paid <in_...> <cardano_tx_hash>');
    const paid = await markPaidOutOfBand(vendorStripe(process.env.STRIPE_VENDOR_SECRET_KEY), invoiceId, txHash);
    console.log(`${paid.id} status=${paid.status} cardano_tx_hash=${paid.metadata?.cardano_tx_hash}`);
    break;
  }
  default:
    console.error('usage: stripe <customer | seed [stage|masumi|lab ...] | reset [sets] | list | mark-paid <in_...> <tx_hash>>');
    process.exit(1);
}
