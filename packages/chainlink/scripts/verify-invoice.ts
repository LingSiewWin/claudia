// End-to-end verification run: the CRE simulator fetches the Stripe invoice and writes the report
// to Sepolia (--broadcast); the report is then read back from Sepolia and hash-checked.
// Usage: pnpm --filter @authority/chainlink verify-invoice <invoice_id> <amount_usdm_units> <recipient_addr>
import { resolve } from 'node:path';
import { ActionIRSchema } from '@authority/core';
import { createPublicClient, getAddress, http } from 'viem';
import { sepolia } from 'viem/chains';
import { simulateBroadcast, type Trigger, verificationRequestFor, verifyInvoice } from '../src/trigger';

const root = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(root, '.env'));

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
};

const [invoiceId, amount, recipient] = process.argv.slice(2);
if (!invoiceId || !amount || !recipient) {
  throw new Error('usage: verify-invoice <invoice_id> <amount_usdm_units> <recipient_addr>');
}

const action = ActionIRSchema.parse({
  schema: 'action-ir/v0.1',
  id: `A-CRE-${Date.now()}`,
  mandate_id: 'M-001',
  actor: 'cfo-agent-01',
  type: 'pay_invoice',
  purpose: 'invoice_payment',
  counterparty: { id: 'aws', display: 'AWS (demo vendor)' },
  amount: { value: amount, asset: 'USDM' },
  recipient: { chain: 'cardano', address: recipient },
  source: { vault: 'acme-treasury' },
  reference: { invoice_id: invoiceId, invoice_number: invoiceId },
  rationale: 'Verification run for the CRE workflow.',
  created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
});

const simulate = simulateBroadcast({ workflowsDir: resolve(root, 'workflows'), envFile: resolve(root, '.env') });
const trigger: Trigger = async (payload) => {
  const output = await simulate(payload);
  console.log(output);
  return output;
};

const request = verificationRequestFor(action, env('STRIPE_ACME_CUSTOMER_ID'));
const outcome = await verifyInvoice(request, {
  trigger,
  client: createPublicClient({ chain: sepolia, transport: http(env('SEPOLIA_RPC_URL')) }),
  registry: getAddress(env('VERIFICATION_REGISTRY_ADDRESS')),
});

console.log(
  JSON.stringify(
    {
      action_hash: request.action_hash,
      outcome,
      explorer: outcome.status === 'reported' ? `https://sepolia.etherscan.io/tx/${outcome.tx_hash}` : null,
    },
    null,
    2,
  ),
);
if (outcome.status !== 'reported') process.exitCode = 1;
