// The demo stage run (cases 1-7) on preprod through the running Authority API. Proposals come from the open
// Stripe invoices and are signed with the M-001 agent key, exactly as the agent runtime does; the CFO steps are
// signed with the CFO test wallet (CIP-30-equivalent partial tx signature and CIP-8 signData).
// Usage: pnpm --filter @authority/api stage
// Env: AUTHORITY_API_URL, AUTHORITY_AGENT_KEY, M001_AGENT_SECRET_KEY, STRIPE_READ_KEY, STRIPE_ACME_CUSTOMER_ID, CFO_TEST_MNEMONIC
import { setTimeout as sleep } from 'node:timers/promises';
import { ActionIRSchema, bytesToHex, canonicalHash, hexOfLength, signProposal, utf8ToBytes } from '@authority/core';
import { listOpenInvoices, readOnlyStripe } from '@authority/stripe';
import { deserializeAddress, MeshWallet } from '@meshsdk/core';
import { declineMessage } from '../src/approvals';

const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const api = need('AUTHORITY_API_URL').replace(/\/+$/, '');
const agentKey = need('AUTHORITY_AGENT_KEY');
const agentSk = hexOfLength(need('M001_AGENT_SECRET_KEY'), 32, 'M001_AGENT_SECRET_KEY');
// Keyless demo addresses: enterprise key hashes sha256("authority-demo-attacker"|"authority-demo-nft")[0..28].
const ATTACKER = 'addr_test1vzq6234e83ye84passjwpexr0fwtnch7lm8kjn2wphtuy6q4yau55';
const NFT = 'addr_test1vzctcka849xmza42cmz2qm2za8qcvfqdv6mxsz3xgsgy0qcg5qegt';

async function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(600_000),
  });
  const json = res.status === 204 ? null : ((await res.json()) as any);
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const agent = { authorization: `Bearer ${agentKey}` };

// The CFO test wallet must be the M-001 approver.
const cfo = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: need('CFO_TEST_MNEMONIC').split(/\s+/) } });
await cfo.init();
const cfoAddress = await cfo.getChangeAddress();
const view = await call('GET', '/v1/mandates/M-001');
const approver = view.mandate.approvers.find((a: { role: string }) => a.role === 'CFO').cardano_key_hash;
if (deserializeAddress(cfoAddress).pubKeyHash !== approver) throw new Error('CFO_TEST_MNEMONIC is not the M-001 CFO approver');
if (view.vault.balance !== '135000000' || view.vault.spent_today !== '0') {
  throw new Error(`stage runs start from balance 135.00 and nothing spent today; vault has ${view.vault.balance} / ${view.vault.spent_today}. Reset the vault first.`);
}

const open = await listOpenInvoices(readOnlyStripe(need('STRIPE_READ_KEY')), need('STRIPE_ACME_CUSTOMER_ID'));
const invoice = (number: string) => {
  const found = open.find((i) => i.number === number && i.payout_address);
  if (!found) throw new Error(`${number} is not open; seed the stage invoices first`);
  return found;
};
const proposal = (o: { id: string; number?: string; recipient?: string; vendor?: [string, string]; nft?: boolean; rationale: string }) => {
  const inv = o.number ? invoice(o.number) : null;
  const action = ActionIRSchema.parse({
    schema: 'action-ir/v0.1',
    id: o.id,
    mandate_id: 'M-001',
    actor: view.mandate.delegate.id,
    type: o.nft ? 'purchase' : 'pay_invoice',
    purpose: o.nft ? 'digital_collectibles' : 'invoice_payment',
    counterparty: { id: o.vendor?.[0] ?? 'aws', display: o.vendor?.[1] ?? 'AWS (demo vendor)' },
    amount: { value: inv?.amount_usdm ?? '2000000', asset: 'USDM' },
    recipient: { chain: 'cardano', address: o.recipient ?? inv?.payout_address ?? NFT },
    source: { vault: 'acme-treasury' },
    ...(inv ? { reference: { invoice_id: inv.id, invoice_number: o.number } } : {}),
    rationale: o.rationale,
    created_at: new Date().toISOString(),
  });
  return { action, agent_signature: signProposal(canonicalHash(action), agentSk) };
};

const { run_id: run } = await call('POST', '/v1/runs', { mandate_id: 'M-001' });
const claimed = await call('POST', '/v1/agent/runs/claim', {}, agent);
if (claimed?.run_id !== run) throw new Error(`claimed ${claimed?.run_id}, expected ${run}`);
console.log(`run ${run}`);

async function settled(actionId: string) {
  for (let i = 0; i < 180; i++) {
    const { events } = await call('GET', `/v1/runs/${run}/log`);
    const mine = events.filter((e: { action_id: string }) => e.action_id === actionId);
    const rejected = mine.find((e: { type: string }) => e.type === 'TransactionRejected');
    if (rejected) throw new Error(`${actionId} rejected: ${JSON.stringify(rejected.payload)}`);
    const proven = mine.find((e: { type: string }) => e.type === 'ReceiptProven');
    if (proven) return { receipt: proven.payload.receipt_id, tx: mine.find((e: { type: string }) => e.type === 'TransactionConfirmed').payload.tx_hash };
    await sleep(5_000);
  }
  throw new Error(`${actionId} did not settle in 15 minutes`);
}

const cases = [
  { n: 1, p: { id: 'A-0001', number: 'INV-3821', rationale: 'Invoice INV-3821 is open and matches an approved cloud expense.' } },
  { n: 2, p: { id: 'A-0002', number: 'INV-3822', rationale: 'INV-3822 covers the reserved capacity commitment.' }, cfo: 'approve' },
  { n: 3, p: { id: 'A-0003', number: 'INV-G-0042', vendor: ['globex', 'Globex (demo vendor)'] as [string, string], rationale: 'Globex sent an invoice for consulting hours.' }, cfo: 'decline' },
  { n: 4, p: { id: 'A-0004', number: 'INV-3825', rationale: 'INV-3825 is the annual support plan.' } },
  { n: 5, p: { id: 'A-0005', nft: true, rationale: 'A collectible would make a good brand asset.' } },
  { n: 6, p: { id: 'A-0006', number: 'INV-3823', recipient: ATTACKER, rationale: 'AWS billing emailed that their bank changed; paying INV-3823 to the new address.' } },
  { n: 7, p: { id: 'A-0007', number: 'INV-3824', rationale: 'INV-3824 is open for storage overage.' } },
] as const;

for (const c of cases) {
  const res = await call('POST', '/v1/authority/check', { mandate_id: 'M-001', proposal: proposal(c.p), execute: true, run_id: run }, {
    ...agent,
    'idempotency-key': `stage:${run}:${c.p.id}`,
  });
  const row: Record<string, unknown> = { case: c.n, action: c.p.id, outcome: res.evaluation.outcome, reason: res.evaluation.reason, receipt: res.receipt_id };
  if (res.verification) row.sepolia = `https://sepolia.etherscan.io/tx/${res.verification.sepolia_tx}`;
  if ('cfo' in c && c.cfo === 'approve') {
    const approved = await call('POST', `/v1/approvals/${res.approval_id}/approve`, {});
    const witness = await cfo.signTx(approved.unsigned_tx_cbor, true, false);
    await call('POST', '/v1/executions', { approval_id: res.approval_id, authorization_digest: approved.authorization.digest_hex, cfo_witness_cbor: witness });
    row.requires_principal = approved.authorization.fields.requires_principal;
  }
  if ('cfo' in c && c.cfo === 'decline') {
    const sig = await cfo.signData(bytesToHex(utf8ToBytes(declineMessage(res.approval_id))), cfoAddress);
    await call('POST', `/v1/approvals/${res.approval_id}/decline`, sig);
    row.reason = 'PRINCIPAL_DECLINED';
  }
  if (c.n === 1 || c.n === 2) {
    const s = await settled(c.p.id);
    row.settlement = `https://preprod.cexplorer.io/tx/${s.tx}`;
    row.settlement_receipt = s.receipt;
  }
  console.log(JSON.stringify(row));
}
await call('POST', `/v1/agent/runs/${run}/finish`, {}, agent);

const { events } = await call('GET', `/v1/runs/${run}/log`);
const cre = (id: string) => events.filter((e: { action_id: string; type: string }) => e.action_id === id && e.type === 'CREVerificationStarted').length;
console.log(JSON.stringify({ cre_triggers: Object.fromEntries(cases.map((c) => [c.p.id, cre(c.p.id)])), events: events.length }));
const after = await call('GET', '/v1/mandates/M-001');
console.log(JSON.stringify({ vault_balance: after.vault.balance, spent_today: after.vault.spent_today, last_nonce: after.vault.last_nonce }));
