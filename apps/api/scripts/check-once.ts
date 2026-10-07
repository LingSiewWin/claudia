// One signed evaluation (execute: false) of an open invoice through a running Authority API, sent with the
// Masumi key exactly as the Masumi worker does. Usage: pnpm --filter @authority/api check-once <invoice number>
import { ActionIRSchema, canonicalHash, hexOfLength, signProposal } from '@authority/core';
import { listOpenInvoices, readOnlyStripe } from '@authority/stripe';

const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const number = process.argv[2];
if (!number) throw new Error('usage: check-once <invoice number>');
const open = await listOpenInvoices(readOnlyStripe(need('STRIPE_READ_KEY')), need('STRIPE_ACME_CUSTOMER_ID'));
const inv = open.find((i) => i.number === number && i.payout_address);
if (!inv?.payout_address) throw new Error(`${number} is not an open invoice with a payout address`);
const action = ActionIRSchema.parse({
  schema: 'action-ir/v0.1',
  id: `A-ONCE-${Date.now()}`,
  mandate_id: 'M-001',
  actor: 'cfo-agent-01',
  type: 'pay_invoice',
  purpose: 'invoice_payment',
  counterparty: { id: 'aws', display: 'AWS (demo vendor)' },
  amount: { value: inv.amount_usdm, asset: 'USDM' },
  recipient: { chain: 'cardano', address: inv.payout_address },
  source: { vault: 'acme-treasury' },
  reference: { invoice_id: inv.id, invoice_number: number },
  rationale: 'Hosted verification check.',
  created_at: new Date().toISOString(),
});
const agentSk = hexOfLength(need('M001_AGENT_SECRET_KEY'), 32, 'M001_AGENT_SECRET_KEY');
const res = await fetch(`${need('AUTHORITY_API_URL').replace(/\/+$/, '')}/v1/authority/check`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${need('AUTHORITY_MASUMI_KEY')}`,
    'idempotency-key': `check-once:${action.id}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ mandate_id: 'M-001', proposal: { action, agent_signature: signProposal(canonicalHash(action), agentSk) }, execute: false }),
  signal: AbortSignal.timeout(600_000),
});
const b = (await res.json()) as { error?: string; evaluation?: { outcome: string; reason: string | null }; verification?: { sepolia_tx: string } | null; receipt_id?: string };
console.log(
  JSON.stringify({
    status: res.status,
    outcome: b.evaluation?.outcome ?? null,
    reason: b.evaluation?.reason ?? b.error ?? null,
    sepolia_tx: b.verification?.sepolia_tx ?? null,
    receipt: b.receipt_id ?? null,
  }),
);
