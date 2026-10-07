// Attack Lab: escalation spam. The agent proposes four actions that each need approval. Each one costs a bond
// and one unit of the day's interrupt budget (3), so three are priced (402, paid, approver paged) and the fourth
// is denied by the engine before any human hears of it.
// Usage: pnpm --filter @authority/agent escalation-spam            (offline, against the in-memory fake authority)
//        pnpm --filter @authority/agent escalation-spam -- --live [--mandate M-001|M-LAB]  (against AUTHORITY_API_URL; locks real preprod bonds)
//        M-LAB proposes an open invoice of an unlisted vendor (escalates on counterparty) and executes.
// Live env: AUTHORITY_API_URL, AUTHORITY_AGENT_KEY, M001_AGENT_SECRET_KEY, STRIPE_READ_KEY, STRIPE_ACME_CUSTOMER_ID,
//           AGENT_WALLET_MNEMONIC, BLOCKFROST_PROJECT_ID_PREPROD, AGENT_MAX_BOND_LOVELACE
import { canonicalHash, type Mandate, signProposal } from '@authority/core';
import { buildAction, sourceVaultFor, unitsToDecimal } from '@authority/llm';
import { listOpenInvoices, readOnlyStripe } from '@authority/stripe';
import type { AuthorityClient } from '../src/authority';
import { httpAuthority } from '../src/authority';
import { type BondContext, BondRefused, type BondPayer, cardanoBondPayer, checkWithBond, fakeBondPayer, newEscalationState, newSummary } from '../src/bond';
import { loadConfig } from '../src/config';
import { ADDR, AGENT_SK, fakeAuthority, M001 } from '../test/fake-authority';

const live = process.argv.includes('--live');
const ROUNDS = 4;

interface Target {
  api: AuthorityClient;
  payer: BondPayer;
  maxBondLovelace: bigint;
  mandate: Mandate;
  secretKey: Uint8Array;
  runId: string;
  execute: boolean;
  invoice: { id: string; number: string; amount: string; vendor_id: string; vendor_name: string; address: string };
  finish: () => Promise<void>;
}

async function offlineTarget(): Promise<Target> {
  // The CFO declines every request, so the invoice stays open and each round is a fresh escalation of the same bill.
  const fake = fakeAuthority({ cfo: () => 'decline' });
  const claim = (await fake.client.claim())!;
  return {
    api: fake.client,
    payer: fakeBondPayer(),
    maxBondLovelace: 10_000_000n,
    mandate: M001,
    secretKey: AGENT_SK,
    runId: claim.run_id,
    execute: true,
    invoice: { id: 'in_3822', number: 'INV-3822', amount: '18', vendor_id: 'aws', vendor_name: 'AWS (demo vendor)', address: ADDR.aws },
    finish: () => fake.client.finish(claim.run_id),
  };
}

async function liveTarget(): Promise<Target> {
  const cfg = loadConfig(process.env);
  const flag = process.argv.indexOf('--mandate');
  const mandateId = flag >= 0 ? (process.argv[flag + 1] ?? '') : 'M-001';
  if (mandateId !== 'M-001' && mandateId !== 'M-LAB') throw new Error('--mandate must be M-001 or M-LAB');
  const secretKey = cfg.agentKeys.get(mandateId);
  if (!secretKey) throw new Error(`${mandateId === 'M-001' ? 'M001' : 'M_LAB'}_AGENT_SECRET_KEY is not set`);
  const api = httpAuthority({ url: cfg.apiUrl, key: cfg.apiKey });
  const view = await api.mandate(mandateId);
  const open = await listOpenInvoices(readOnlyStripe(cfg.stripeReadKey), cfg.customerId);
  const limit = BigInt(view.limits.autonomous_limit);
  const approved = new Set(view.mandate.constraints.flatMap((c) => (c.kind === 'counterparty_in' ? c.values : [])));
  // M-001: an invoice above the autonomous limit. M-LAB: an open invoice of a vendor the mandate does not list.
  const inv = open.find((i) => i.payout_address && i.vendor_id && i.number && (mandateId === 'M-001' ? BigInt(i.amount_usdm) > limit : !approved.has(i.vendor_id)));
  if (!inv) throw new Error('no suitable open invoice; seed the stage or lab invoices first');
  // Stage runs start under the stage mandate; lab runs are Attack Lab runs (this one: escalation_spam).
  const res =
    mandateId === 'M-001'
      ? await fetch(`${cfg.apiUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandate_id: mandateId }) })
      : await fetch(`${cfg.apiUrl}/v1/lab/attacks`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` }, body: JSON.stringify({ attack: 'escalation_spam' }) });
  if (!res.ok) throw new Error(`start run: HTTP ${res.status} ${await res.text()}`);
  const { run_id: runId } = (await res.json()) as { run_id: string };
  const claim = await api.claim();
  if (claim?.run_id !== runId) throw new Error(`claimed ${claim?.run_id ?? 'nothing'}, expected ${runId}: stop the agent process and retry`);
  return {
    api,
    payer: cardanoBondPayer(process.env),
    maxBondLovelace: cfg.maxBondLovelace,
    mandate: view.mandate,
    secretKey,
    runId,
    // M-001 is not executed (the approver is paged, nothing is released even on approve); M-LAB goes through the 402 gate.
    execute: mandateId === 'M-LAB',
    invoice: { id: inv.id, number: inv.number!, amount: unitsToDecimal(inv.amount_usdm, view.mandate.asset.decimals), vendor_id: inv.vendor_id!, vendor_name: inv.vendor_name ?? inv.vendor_id!, address: inv.payout_address! },
    finish: () => api.finish(runId),
  };
}

const t = live ? await liveTarget() : await offlineTarget();
const lines: Record<string, unknown>[] = [];
const ctx: BondContext = {
  authority: t.api,
  payer: t.payer,
  maxBondLovelace: t.maxBondLovelace,
  state: newEscalationState(),
  summary: newSummary(),
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, live ? ms : 0)),
  log: (l) => void lines.push(l),
};

const rows: { round: number; action_id: string; http: string; outcome: string; reason: string; bond_tx: string; approval: string }[] = [];
try {
  for (let round = 1; round <= ROUNDS; round++) {
    const id = `SPAM-${t.runId.slice(0, 8)}-${round}`;
    const action = buildAction(
      {
        type: 'pay_invoice',
        purpose: 'invoice_payment',
        counterparty_id: t.invoice.vendor_id,
        counterparty_display: t.invoice.vendor_name,
        amount: t.invoice.amount,
        recipient_address: t.invoice.address,
        invoice: { invoice_id: t.invoice.id, invoice_number: t.invoice.number },
        rationale: `Escalation spam round ${round}: asking the approver again for ${t.invoice.number}.`,
      },
      { id, mandate: t.mandate, sourceVault: sourceVaultFor(t.mandate.id), nowIso: new Date().toISOString() },
    );
    const body = { mandate_id: t.mandate.id, proposal: { action, agent_signature: signProposal(canonicalHash(action), t.secretKey) }, execute: t.execute, run_id: t.runId };
    const before = lines.length;
    try {
      const reply = await checkWithBond(ctx, body, `spam:${t.runId}:${id}`);
      const locked = lines.slice(before).find((l) => l.event === 'bond_locked');
      rows.push({
        round,
        action_id: id,
        http: locked ? '402 -> paid -> 200' : '200',
        outcome: reply.evaluation.outcome,
        reason: reply.evaluation.reason ?? '-',
        bond_tx: locked ? String(locked.tx_hash).slice(0, 16) + '..' : '-',
        approval: reply.approval_id ?? '-',
      });
    } catch (error) {
      if (!(error instanceof BondRefused)) throw error;
      rows.push({ round, action_id: id, http: '402 -> refused', outcome: 'UNPAID', reason: error.reason, bond_tx: '-', approval: '-' });
    }
  }
} finally {
  await t.finish();
}

console.table(rows);
const paged = rows.filter((r) => r.outcome === 'ESCALATE').length;
const denied = rows.filter((r) => r.reason === 'INTERRUPT_BUDGET_EXHAUSTED').length;
console.log(JSON.stringify({ mode: live ? 'live' : 'offline', run_id: t.runId, ...ctx.summary, humans_paged: paged, denied_before_human: denied }));
// Fresh day: three priced escalations, the fourth denied. Budget already spent today: every round denied, nobody paged.
const expected = (paged === 3 && denied === 1 && rows[3]?.reason === 'INTERRUPT_BUDGET_EXHAUSTED') || (paged === 0 && denied === rows.length);
console.log(expected ? `escalation spam stopped at the interrupt budget: ${paged} priced escalations, ${denied} denied before any human` : 'unexpected result');
if (!expected) process.exit(1);
