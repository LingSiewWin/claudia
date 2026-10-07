// Builds the three ready examples from the open Masumi demo invoices and signs them with the M-001 agent key
// (local only). Writes src/examples.json, which holds public data only.
// Usage: pnpm --filter @authority/masumi-worker examples
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ActionIRSchema, canonicalHash, hexOfLength, signProposal } from '@authority/core';
import { listOpenInvoices, readOnlyStripe, type InvoiceSummary } from '@authority/stripe';

// Must equal delegate.id of the deployed M-001 mandate (the engine denies AGENT_NOT_DELEGATE otherwise).
const ACTOR = 'cfo-agent-01';
const VAULT = 'acme-treasury';
// Enterprise key address whose key hash is sha256("authority-demo-attacker")[0..28]; nobody holds its key.
const ATTACKER = 'addr_test1vzq6234e83ye84passjwpexr0fwtnch7lm8kjn2wphtuy6q4yau55';
const CREATED_AT = '2026-10-07T00:00:00.000Z';

const customer = process.env.STRIPE_ACME_CUSTOMER_ID?.trim();
if (!customer) throw new Error('STRIPE_ACME_CUSTOMER_ID is required');
const agentKey = hexOfLength(process.env.M001_AGENT_SECRET_KEY?.trim() ?? '', 32, 'M001_AGENT_SECRET_KEY');
const open = await listOpenInvoices(readOnlyStripe(process.env.STRIPE_READ_KEY), customer);

const invoice = (number: string): InvoiceSummary => {
  const found = open.find((i) => i.number === number);
  if (!found?.payout_address) throw new Error(`${number} is not an open invoice with a payout address; run the Stripe seed for the masumi set`);
  return found;
};

const example = (number: string, rationale: string, recipient?: string) => {
  const inv = invoice(number);
  const action = ActionIRSchema.parse({
    schema: 'action-ir/v0.1',
    id: `A-${number}`,
    mandate_id: 'M-001',
    actor: ACTOR,
    type: 'pay_invoice',
    purpose: 'invoice_payment',
    counterparty: { id: 'aws', display: 'AWS (demo vendor)' },
    amount: { value: inv.amount_usdm, asset: 'USDM' },
    recipient: { chain: 'cardano', address: recipient ?? inv.payout_address },
    source: { vault: VAULT },
    reference: { invoice_id: inv.id, invoice_number: number },
    rationale,
    created_at: CREATED_AT,
  });
  return { mandate_id: 'M-001', proposal: { action, agent_signature: signProposal(canonicalHash(action), agentKey) } };
};

const examples = {
  allow: example('INV-M-0001', 'Open AWS invoice for October cloud compute, within the autonomous limit.'),
  escalate: example('INV-M-0002', 'Open AWS invoice for reserved capacity, above the autonomous limit; the CFO must sign.'),
  deny: example('INV-M-0003', 'A vendor email says AWS changed its bank details; paying the new address.', ATTACKER),
};
writeFileSync(fileURLToPath(new URL('../src/examples.json', import.meta.url)), `${JSON.stringify(examples, null, 2)}\n`);
console.log('wrote src/examples.json:', Object.keys(examples).join(', '));
