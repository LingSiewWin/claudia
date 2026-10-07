// fx_lock end to end against the Crebit sandbox, with the engine in process: partner check -> supported chains ->
// customer reference -> quote -> engine (NEEDS_VERIFICATION) -> quote read back and verified -> decision brief.
// Usage: pnpm --filter @authority/api fx-demo [notional_usd] [tenor_hours]
// Needs CREBIT_ENV, CREBIT_KEY_ID, CREBIT_KEY_SECRET, CREBIT_PAYOUT_WALLET in the local .env; without them it exits 2.
// It never fakes a run: with no keys nothing below is printed as a result.
import {
  briefHash,
  buildBrief,
  bytesToHex,
  canonicalHash,
  evaluate,
  type Mandate,
  parseMandate,
  publicKeyFromSecret,
  signProposal,
} from '@authority/core';
import { crebitFromEnv, fxLockAction, missingCrebitEnv, quoteView } from '@authority/crebit';
import { fxVerifier } from '../src/fx';

const missing = [...missingCrebitEnv(process.env), ...(process.env.CREBIT_PAYOUT_WALLET?.trim() ? [] : ['CREBIT_PAYOUT_WALLET'])];
if (missing.length > 0) {
  console.error(`fx-lock-demo: missing env ${missing.join(', ')} (set them in the local .env). Nothing was run.`);
  process.exit(2);
}
const client = crebitFromEnv(process.env)!;
const payoutWallet = process.env.CREBIT_PAYOUT_WALLET!.trim();
const notional = process.argv[2] ?? '1000.00';
const tenorHours = Number(process.argv[3] ?? 24 * 7);
const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const show = (label: string, v: unknown) => console.log(`\n== ${label}\n${JSON.stringify(v, null, 2)}`);

// In-process engine keys (TEST keys, no funds, nothing signed here reaches a chain). The decision is real; the
// authorization path (402 bond, CFO approval) needs M-FX seeded in the deployed API and is not part of this script.
const ENGINE_SK = new Uint8Array(32).fill(1);
const AGENT_SK = new Uint8Array(32).fill(2);
const mandate: Mandate = parseMandate({
  schema: 'mandate/v0.1',
  id: 'M-FX',
  version: 1,
  status: 'active',
  principal: { type: 'organization', id: 'acme', name: 'Acme Corp', cardano_key_hash: 'ad'.repeat(28) },
  delegate: { type: 'agent', id: 'cfo-agent-01', public_key: `ed25519:${bytesToHex(publicKeyFromSecret(AGENT_SK))}` },
  approvers: [{ role: 'CFO', cardano_key_hash: 'cf'.repeat(28) }],
  authority_engine: { public_key: `ed25519:${bytesToHex(publicKeyFromSecret(ENGINE_SK))}` },
  asset: { symbol: 'USDC', decimals: 6 },
  validity: { starts_at: '2026-10-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z' },
  delegation: { allowed: false },
  interrupt_budget: { per_day: 3 },
  fx: { corridors: ['USD-BRL'], max_notional: '50000000000', max_tenor_hours: 24 * 30, max_basis_bps: 50, counterparty: 'crebit' },
  constraints: [
    { id: 'purpose', kind: 'purpose_in', values: ['fx_hedge'], on_violation: 'DENY' },
    { id: 'action', kind: 'action_in', values: ['fx_lock'], on_violation: 'DENY' },
    { id: 'asset', kind: 'asset_eq', value: 'USDC', on_violation: 'DENY' },
    { id: 'counterparty', kind: 'counterparty_in', values: ['crebit'], on_violation: 'DENY' },
    { id: 'autonomous', kind: 'amount_lte', value: '20000000', on_violation: 'ESCALATE', approver: 'CFO' },
    { id: 'hard_cap', kind: 'amount_lte', value: '10000000000', on_violation: 'DENY' },
    { id: 'daily_cap', kind: 'daily_spend_lte', value: '10000000000', on_violation: 'DENY' },
    { id: 'treasury_floor', kind: 'balance_after_gte', value: '1000000000', on_violation: 'DENY' },
    { id: 'fx_corridor', kind: 'fx_corridor_in', on_violation: 'DENY' },
    { id: 'fx_notional', kind: 'fx_notional_lte', on_violation: 'ESCALATE', approver: 'CFO' },
    { id: 'fx_tenor', kind: 'fx_tenor_lte', on_violation: 'DENY' },
    { id: 'fx_type', kind: 'fx_contract_type_in', on_violation: 'DENY' },
    { id: 'fx_fresh', kind: 'fx_quote_fresh', on_violation: 'DENY' },
    { id: 'fx_basis', kind: 'fx_basis_lte', on_violation: 'DENY' },
    { id: 'quote_facts', kind: 'verified_facts', source: 'crebit', on_violation: 'DENY' },
  ],
});

show('partners/me', await client.me());
const chains = await client.supportedChains();
show('supported-chains (enabled)', chains.chains.filter((c) => c.enabled));
if (!chains.chains.some((c) => c.chain === 'solana' && c.enabled && c.settlement_currencies.includes('USDC'))) {
  console.error('solana/USDC is not enabled for this partner; stopping');
  process.exit(1);
}
show('customer-reference', await client.createCustomerReference(mandate.principal.id));
const start = now() + 5 * 60_000;
const quote = await client.createQuote({
  customer_reference_id: mandate.principal.id,
  customer_name: mandate.principal.name,
  contract_type: 'option',
  direction: 'USD_TO_BRL',
  notional_currency: 'USD',
  notional_amount: notional,
  window_start: iso(start),
  window_end: iso(start + tenorHours * 3_600_000),
  chain: 'solana',
  settlement_currency: 'USDC',
  payout_wallet_address: payoutWallet,
  strike_mode: 'live_spot',
  oracle: 'redstone',
});
show('quote (POST /fx/quotes)', quote);
// The agent-side build reads direction/contract_type/notional from the quote; fill them from the request if Crebit omits them.
const full = { ...quote, direction: quote.direction ?? 'USD_TO_BRL', contract_type: quote.contract_type ?? 'option', notional_amount: quote.notional_amount ?? notional };
const action = fxLockAction(full, { id: `A-FX-${Date.now()}`, mandate, sourceVault: 'acme-treasury', nowIso: new Date(now()).toISOString(), rationale: 'Hedge the BRL supplier payable (sandbox demo).' });
show('action ir', action);
const state = { vault_balance: '100000000000', spent_today: '0', day_index: Math.floor(now() / 86_400_000), last_nonce: '0', anchor_version: 1, anchor_status: 'active' as const, observed_at_slot: 1 };
const proposal = { action, agent_signature: signProposal(canonicalHash(action), AGENT_SK) };
const first = evaluate({ mandate, proposal, state, verification: null, nowMs: now() });
console.log(`\n== engine first pass: ${first.outcome}`);
let verification = null;
let decision = first;
if (first.outcome === 'NEEDS_VERIFICATION') {
  const out = await fxVerifier((id) => client.getQuote(id), now)(action, `demo-${Date.now()}`, { maxBasisBps: mandate.fx!.max_basis_bps, decimals: 6 });
  if (out.status !== 'reported') {
    console.error(`verification unavailable: ${out.error}`);
    process.exit(1);
  }
  show('fx verification report (GET /fx/quotes/{id} read back)', { ...out.verified.report, report_hash: out.verified.report_hash });
  verification = { report: out.verified.report, report_hash: out.verified.report_hash, sepolia_tx: null };
  decision = evaluate({ mandate, proposal, state, verification: out.verified, nowMs: now() });
}
show('engine decision', { outcome: decision.outcome, reason: decision.reason, approvals_required: decision.approvals_required, checks: decision.checks.map((c) => [c.id, c.result, c.reason]) });
if (decision.outcome !== 'NEEDS_VERIFICATION') {
  const brief = buildBrief({ action, evaluation: decision, mandate, verification, bond: decision.outcome === 'ESCALATE' ? { amount: '5000000', asset: 'ADA' } : null, expires_at_ms: now() + 3_600_000 });
  show('decision brief', brief);
  console.log(`\nbrief_hash ${briefHash(brief)}\naction_hash ${canonicalHash(action)}\nquote_id ${quote.id}\n`);
  console.log('Next (not done by this script): seed M-FX in the API, POST /v1/authority/check with execute:true, pay the 402 bond, CFO approval, then POST /fx/contracts and fund amount_due to funding_wallet_address from the human wallet.');
}
