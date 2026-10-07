// One escalation on M-001 paid the x402 exact-scheme way: the official @x402/core client reads our 402, the
// Cardano scheme client (@x402/cardano) builds the PAYMENT-SIGNATURE from a signed, unbroadcast lock tx of the
// agent wallet, and the API submits the lock and pages the approver. Spends one unit of the interrupt budget.
// Usage: pnpm --filter @authority/api x402-exact [--api http://127.0.0.1:8789] [--probe-facilitator: sign, POST /verify, print, stop]
// Env: AUTHORITY_API_URL, AUTHORITY_AGENT_KEY, M001_AGENT_SECRET_KEY, STRIPE_READ_KEY, STRIPE_ACME_CUSTOMER_ID,
//      AGENT_WALLET_MNEMONIC, BLOCKFROST_PROJECT_ID_PREPROD
import { setTimeout as sleep } from 'node:timers/promises';
import { bondDatumCbor, connect, signBondLock, walletFromMnemonic } from '@authority/cardano';
import { ActionIRSchema, canonicalHash, EscalationPriceSchema, hexOfLength, signProposal } from '@authority/core';
import { listOpenInvoices, readOnlyStripe } from '@authority/stripe';
import { type ClientCardanoSigner, type ClientCardanoSignInput } from '@x402/cardano';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';

const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const api = (arg('--api') ?? need('AUTHORITY_API_URL')).replace(/\/+$/, '');
const agent = { authorization: `Bearer ${need('AUTHORITY_AGENT_KEY')}` };
const agentSk = hexOfLength(need('M001_AGENT_SECRET_KEY'), 32, 'M001_AGENT_SECRET_KEY');

async function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as any) : null;
  if (res.status !== 402 && !res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return { status: res.status, headers: res.headers, json };
}

// The signer: builds the escrow lock with the escalation_bond datum from extra.escalation and signs it. Never broadcasts.
const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
const wallet = await walletFromMnemonic(chain, process.env.AGENT_WALLET_MNEMONIC, 'AGENT_WALLET_MNEMONIC');
const signer: ClientCardanoSigner = {
  getAddress: () => wallet.address,
  async buildAndSignPaymentTransaction(input: ClientCardanoSignInput) {
    const extra = input.extra as { escalation?: unknown; datum?: string } | undefined;
    const price = EscalationPriceSchema.parse(extra?.escalation);
    if (input.payTo !== price.escrow_address || input.amount !== price.amount) throw new Error('402 entry and escalation price disagree');
    // The server-issued datum is attached verbatim (what any exact-scheme client does); it must be the lock datum for this wallet.
    if (extra?.datum === undefined || extra.datum !== bondDatumCbor(price, wallet.address)) throw new Error('402 extra.datum is not the escalation_bond datum for the agent wallet');
    const lock = await signBondLock(chain, wallet, price, { datumCbor: extra.datum });
    console.log(JSON.stringify({ lock_signed: price.approval_id, tx_hash: lock.txHash, nonce: lock.nonce, amount: price.amount, escrow: price.escrow_address, broadcast: false }));
    return { transaction: Buffer.from(lock.txHex, 'hex').toString('base64'), nonce: lock.nonce };
  },
};
const client = new x402Client().register('cardano:preprod', new ExactCardanoScheme(signer)).setSpendControls(false);

// One open invoice above the autonomous limit, signed with the M-001 agent key as the agent runtime does.
const view = (await call('GET', '/v1/mandates/M-001')).json;
const limit = BigInt(view.limits.autonomous_limit);
const open = await listOpenInvoices(readOnlyStripe(need('STRIPE_READ_KEY')), need('STRIPE_ACME_CUSTOMER_ID'));
const inv = open.find((i) => i.payout_address && i.vendor_id === 'aws' && i.number && BigInt(i.amount_usdm) > limit);
if (!inv) throw new Error('no open AWS invoice above the autonomous limit; seed the stage invoices first');

const { run_id: run } = (await call('POST', '/v1/runs', { mandate_id: 'M-001' })).json;
const claimed = (await call('POST', '/v1/agent/runs/claim', {}, agent)).json;
if (claimed?.run_id !== run) throw new Error(`claimed ${claimed?.run_id ?? 'nothing'}, expected ${run}: stop the agent process and retry`);
const id = `X402-${run.slice(0, 8)}`;
const action = ActionIRSchema.parse({
  schema: 'action-ir/v0.1',
  id,
  mandate_id: 'M-001',
  actor: view.mandate.delegate.id,
  type: 'pay_invoice',
  purpose: 'invoice_payment',
  counterparty: { id: inv.vendor_id, display: inv.vendor_name ?? inv.vendor_id },
  amount: { value: inv.amount_usdm, asset: 'USDM' },
  recipient: { chain: 'cardano', address: inv.payout_address },
  source: { vault: 'acme-treasury' },
  reference: { invoice_id: inv.id, invoice_number: inv.number },
  rationale: `${inv.number} is above the autonomous limit; asking the approver, bond paid with the x402 exact scheme.`,
  created_at: new Date().toISOString(),
});
const body = { mandate_id: 'M-001', proposal: { action, agent_signature: signProposal(canonicalHash(action), agentSk) }, execute: false, run_id: run, bond_refund_address: wallet.address };
const headers = { ...agent, 'idempotency-key': `x402:${run}:${id}` };

try {
  const first = await call('POST', '/v1/authority/check', body, headers);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}: ${JSON.stringify(first.json).slice(0, 300)}`);
  const required = decodePaymentRequiredHeader(first.headers.get('payment-required')!);
  console.log(JSON.stringify({ http: 402, accepts: required.accepts.map((a) => `${a.scheme}@${a.network}`), exact_extra: { ...(required.accepts[1]!.extra as object), escalation: '<price>' }, price: required.accepts[0]!.extra }));

  const payload = await client.createPaymentPayload(required);
  const signature = encodePaymentSignatureHeader(payload);
  console.log(JSON.stringify({ payment_signature: { x402Version: payload.x402Version, accepted: `${payload.accepted.scheme}@${payload.accepted.network}`, payload_keys: Object.keys(payload.payload), bytes: signature.length } }));

  if (process.argv.includes('--probe-facilitator')) {
    const url = process.env.X402_FACILITATOR_URL ?? 'https://x402.preprod.dev.ecosyseng.cf-deployments.org';
    const res = await fetch(`${url}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted }),
      signal: AbortSignal.timeout(90_000),
    });
    console.log(JSON.stringify({ facilitator_verify: { url, status: res.status, body: await res.text() } }));
    // The lock stays unbroadcast and no budget is spent: the probe only tells whether the facilitator takes our lock.
    await call('POST', `/v1/agent/runs/${run}/finish`, {}, agent);
    process.exit();
  }

  // The API submits the lock and reads it back once a block carries it; the same header is re-presented meanwhile.
  let reply = first;
  for (let round = 1; reply.status === 402 && round <= 24; round++) {
    reply = await call('POST', '/v1/authority/check', body, { ...headers, 'payment-signature': signature });
    console.log(JSON.stringify({ round, http: reply.status }));
    if (reply.status === 402) await sleep(10_000);
  }
  if (reply.status !== 200) throw new Error(`lock not accepted: ${JSON.stringify(reply.json).slice(0, 500)}`);
  const settlement = decodePaymentResponseHeader(reply.headers.get('payment-response')!);
  console.log(JSON.stringify({ http: 200, outcome: reply.json.evaluation.outcome, approval_id: reply.json.approval_id, bond: reply.json.bond, payment_response: settlement }));
  const inbox = (await call('GET', '/v1/approvals?status=pending')).json.approvals as Array<{ approval_id: string; bond: unknown; brief: { what: unknown } }>;
  const row = inbox.find((a) => a.approval_id === reply.json.approval_id);
  console.log(JSON.stringify({ inbox_row: row ? { approval_id: row.approval_id, bond: row.bond, what: row.brief.what } : null, explorer: `https://preprod.cexplorer.io/tx/${settlement?.transaction}` }));
} finally {
  await call('POST', `/v1/agent/runs/${run}/finish`, {}, agent);
}
