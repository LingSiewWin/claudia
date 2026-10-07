// Builds fixtures/recorded.json: a recorded stage run, Attack Lab runs, receipts, and the matching
// Koios / Sepolia responses. Every hash and signature is real (packages/core) with fixed TEST keys,
// so browser Verify passes on it and fails on any edit. Run: pnpm --filter @authority/web fixtures
import { writeFileSync } from 'node:fs';
import {
  type ActionIR,
  type AuthorizationRecord,
  type Evaluation,
  type Mandate,
  type ReasonCode,
  type VerificationReport,
  bytesToHex,
  canonicalHash,
  canonicalJson,
  concatBytes,
  evaluate,
  hexToBytes,
  mandateHash,
  parseMandate,
  publicKeyFromSecret,
  sha256Hex,
  signProposal,
  utf8ToBytes,
} from '@authority/core';
// Raw signer: @authority/core deliberately exports only issueAuthorization. Fixtures need the raw one to forge the
// out-of-policy authorizations that the Attack Lab's stolen-engine-key runs simulate. Never imported by shipped code.
import { signAuthorization } from '../../../packages/core/src/authorization';
import { signEvidenceAnchor } from '../../../packages/core/src/evidence-anchor';
import { type EthReceipt, type KoiosTx, MANDATE_TOKEN_HEX } from '../lib/chain';
import type {
  ApprovalView,
  AttackId,
  EventType,
  Layer,
  Limits,
  LogAnchorRef,
  LogHead,
  MandateView,
  Payloads,
  Receipt,
  ReceiptBundle,
  ReceiptSummary,
  RunEvent,
  RunSummary,
} from '../lib/contract';
import { parseUnits } from '../lib/format';
import { keyHash } from '../lib/keyhash';

const DAY_MS = 86_400_000;
const T0 = Date.parse('2026-10-07T03:00:00.000Z');
const ASSET = { policy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde', name: '0014df10745553444d' };
const REGISTRY = `0x${'5e'.repeat(20)}`;
const ADDR = {
  aws: 'addr_test1vzs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggfw5wvl',
  globex: 'addr_test1vzet9v4jk2et9v4jk2et9v4jk2et9v4jk2et9v4jk2et9vspneuyz',
  attacker: 'addr_test1vrpu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8sclmre6l',
  nft: 'addr_test1vr2df4x56n2df4x56n2df4x56n2df4x56n2df4x56n2df4qmrdj2c',
};
const PAYOUT: Record<string, string> = { aws: ADDR.aws, globex: ADDR.globex, 'nft-marketplace': ADDR.nft };
const FACT_REASONS = new Set<string>([
  'INVOICE_NOT_FOUND',
  'CUSTOMER_MISMATCH',
  'INVOICE_NOT_OPEN',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'RECIPIENT_MISMATCH',
]);
const u = (d: string) => parseUnits(d).toString();
const txid = (label: string) => sha256Hex(`fixture-tx:${label}`);
const fakeBody = (label: string) => `84a4${sha256Hex(`fixture-body:${label}`)}${sha256Hex(`fixture-body2:${label}`)}`;

interface Setup {
  id: string;
  version: number;
  engineSk: Uint8Array;
  agentSk: Uint8Array;
  vaultHash: string;
  mandateRef: string;
  limits: Limits;
  vendors: string[];
  start: string;
}
interface Vault {
  balance: bigint;
  spent: bigint;
  nonce: bigint;
}

const M001: Setup = {
  id: 'M-001',
  version: 3,
  engineSk: new Uint8Array(32).fill(1), // TEST key, fixtures only
  agentSk: new Uint8Array(32).fill(2), // TEST key, fixtures only
  vaultHash: 'aa'.repeat(28),
  mandateRef: 'bb'.repeat(28),
  limits: { symbol: 'USDM', decimals: 6, autonomous_limit: u('10'), hard_cap: u('50'), daily_cap: u('50'), treasury_minimum: u('100') },
  vendors: ['aws', 'stripe'],
  start: '135',
};
const MLAB: Setup = {
  id: 'M-LAB',
  version: 1,
  engineSk: new Uint8Array(32).fill(3), // TEST key, fixtures only
  agentSk: new Uint8Array(32).fill(4), // TEST key, fixtures only
  vaultHash: 'a2'.repeat(28),
  mandateRef: 'b2'.repeat(28),
  limits: { symbol: 'USDM', decimals: 6, autonomous_limit: u('1'), hard_cap: u('5'), daily_cap: u('5'), treasury_minimum: u('1') },
  vendors: ['aws'],
  start: '10',
};

// Revoked mandate (anchor status Revoked) for the "nobody can spend" state. No runs.
const MREV: Setup = {
  id: 'M-REVOKED',
  version: 2,
  engineSk: new Uint8Array(32).fill(5), // TEST key, fixtures only
  agentSk: new Uint8Array(32).fill(6), // TEST key, fixtures only
  vaultHash: 'a3'.repeat(28),
  mandateRef: 'b3'.repeat(28),
  limits: MLAB.limits,
  vendors: ['aws'],
  start: '10',
};

const pk = (sk: Uint8Array) => bytesToHex(publicKeyFromSecret(sk));
// Fixture approver: the real Cardano key hash (blake2b-224) of a fixed TEST public key, not any real wallet.
const CFO_TEST = keyHash(pk(new Uint8Array(32).fill(7)));
// Fixture admin: repeated TEST bytes, distinct from the payment approver. Not a real wallet.
const ADMIN_TEST = '44'.repeat(28);

function buildMandate(s: Setup, version = s.version): Mandate {
  const l = s.limits;
  return parseMandate({
    schema: 'mandate/v0.1',
    id: s.id,
    version,
    status: 'active',
    principal: { type: 'organization', id: 'acme', name: 'Acme Corp', cardano_key_hash: ADMIN_TEST },
    delegate: { type: 'agent', id: 'cfo-agent-01', public_key: `ed25519:${pk(s.agentSk)}` },
    approvers: [{ role: 'CFO', cardano_key_hash: CFO_TEST }],
    authority_engine: { public_key: `ed25519:${pk(s.engineSk)}` },
    asset: { symbol: 'USDM', decimals: 6 },
    validity: { starts_at: '2026-10-06T00:00:00Z', expires_at: '2026-11-06T00:00:00Z' },
    delegation: { allowed: false },
    constraints: [
      { id: 'purpose', kind: 'purpose_in', values: ['invoice_payment'], on_violation: 'DENY' },
      { id: 'action', kind: 'action_in', values: ['pay_invoice'], on_violation: 'DENY' },
      { id: 'asset', kind: 'asset_eq', value: 'USDM', on_violation: 'DENY' },
      { id: 'counterparty', kind: 'counterparty_in', values: s.vendors, on_violation: 'REQUIRE_APPROVAL', approver: 'CFO' },
      { id: 'autonomous', kind: 'amount_lte', value: l.autonomous_limit, on_violation: 'REQUIRE_APPROVAL', approver: 'CFO' },
      { id: 'hard_cap', kind: 'amount_lte', value: l.hard_cap, on_violation: 'DENY' },
      { id: 'daily_cap', kind: 'daily_spend_lte', value: l.daily_cap, on_violation: 'DENY' },
      { id: 'treasury_floor', kind: 'balance_after_gte', value: l.treasury_minimum, on_violation: 'DENY' },
      { id: 'invoice_facts', kind: 'verified_facts', source: 'stripe', on_violation: 'DENY' },
    ],
  });
}

// ---- global hash-chained event log --------------------------------------------------------------
let seq = 0;
let prev = '00'.repeat(32);
let block = 5_261_400;

class Run {
  readonly events: RunEvent[] = [];
  constructor(
    readonly id: string,
    public t: number,
  ) {}
  emit<K extends EventType>(type: K, actionId: string | null, payload: Payloads[K], gapMs = 600): RunEvent {
    this.t += gapMs;
    seq += 1;
    const body = { seq, run_id: this.id, action_id: actionId, type, payload, created_at: new Date(this.t).toISOString() };
    const hash = sha256Hex(concatBytes(hexToBytes(prev), utf8ToBytes(canonicalJson(body))));
    const event = { ...body, hash, prev_hash: prev } as RunEvent;
    this.events.push(event);
    prev = hash;
    return event;
  }
}

const out = {
  registry: REGISTRY,
  runs: [] as RunSummary[],
  logs: {} as Record<string, RunEvent[]>,
  mandates: {} as Record<string, MandateView>,
  approvals: [] as ApprovalView[],
  approve: {} as Record<string, { authorization: AuthorizationRecord; unsigned_tx_cbor: string; tx_hash: string }>,
  receipts: [] as ReceiptSummary[],
  bundles: {} as Record<string, ReceiptBundle>,
  koios: {} as Record<string, KoiosTx>,
  anchors: {} as Record<string, LogAnchorRef>,
  sepolia: {} as Record<string, EthReceipt>,
};

function started(run: Run, s: Setup, m: Mandate, v: Vault, kind: 'stage' | 'lab', goal: string, attack: AttackId | null) {
  run.emit('RunStarted', null, {
    kind,
    mandate_id: m.id,
    mandate_version: m.version,
    principal: m.principal.name,
    delegate: 'CFO-Agent-01',
    agent_public_key: pk(s.agentSk),
    engine_public_key: pk(s.engineSk),
    limits: s.limits,
    vault: { balance: v.balance.toString(), spent_today: v.spent.toString() },
    goal,
  });
  out.runs.push({ run_id: run.id, kind, mandate_id: m.id, started_at: new Date(run.t).toISOString(), event_count: 0, attack });
}

interface Case {
  id: string;
  amount: string;
  invoice: string | null;
  counterparty?: [string, string];
  recipient?: string;
  purpose?: string;
  type?: 'pay_invoice' | 'purchase';
  cfo?: 'approve' | 'decline';
  rationale: string;
}
interface Checked {
  action: ActionIR;
  actionHash: string;
  signature: string;
  evaluation: Evaluation;
  report: { report: VerificationReport; report_hash: string; sepolia_tx: string } | null;
  approved: boolean;
  firstEventHash: string;
}

function makeAction(s: Setup, c: Case, at: number): ActionIR {
  return {
    schema: 'action-ir/v0.1',
    id: c.id,
    mandate_id: s.id,
    actor: 'cfo-agent-01',
    type: c.type ?? 'pay_invoice',
    purpose: c.purpose ?? 'invoice_payment',
    counterparty: { id: c.counterparty?.[0] ?? 'aws', display: c.counterparty?.[1] ?? 'AWS (demo vendor)' },
    amount: { value: u(c.amount), asset: 'USDM' },
    recipient: { chain: 'cardano', address: c.recipient ?? ADDR.aws },
    source: { vault: s.id === 'M-001' ? 'acme-treasury' : 'acme-lab' },
    ...(c.invoice ? { reference: { invoice_id: `in_${c.invoice.replaceAll('-', '').toLowerCase()}`, invoice_number: c.invoice } } : {}),
    rationale: c.rationale,
    created_at: new Date(at).toISOString(),
  };
}

function cre(run: Run, a: ActionIR, actionHash: string, round: number): Checked['report'] {
  const trigger = `trg-${a.id}-${round}`;
  run.emit('CREVerificationStarted', a.id, { trigger_id: trigger }, 300);
  const payout = PAYOUT[a.counterparty.id] ?? ADDR.aws;
  const match = payout === a.recipient.address;
  const report: VerificationReport = {
    schema: 'verification/v0.1',
    action_hash: actionHash,
    invoice_id: a.reference?.invoice_id ?? 'none',
    invoice_hash: sha256Hex(`invoice:${a.reference?.invoice_id ?? 'none'}`),
    verified_amount: a.amount.value,
    verified_currency: 'usd',
    verified_recipient: payout,
    status: 'open',
    facts: { exists: true, customer_match: true, status_open: true, amount_match: true, currency_match: true, recipient_match: match },
    result: match ? 'VERIFIED' : 'MISMATCH',
    reason: match ? null : 'RECIPIENT_MISMATCH',
    trigger_id: trigger,
  };
  const report_hash = canonicalHash(report);
  const sepolia_tx = `0x${txid(`sepolia:${trigger}`)}`;
  run.t += 9_000;
  run.emit('CREVerificationCompleted', a.id, { report, report_hash, sepolia_tx }, 0);
  out.sepolia[sepolia_tx] = {
    status: '0x1',
    transactionHash: sepolia_tx,
    blockNumber: `0x${(9_500_000 + seq).toString(16)}`,
    logs: [
      {
        address: REGISTRY,
        topics: [`0x${sha256Hex('InvoiceVerified')}`, `0x${actionHash}`, `0x${report_hash}`],
        data: `0x${'0'.repeat(63)}1`,
      },
    ],
  };
  return { report, report_hash, sepolia_tx };
}

/** Propose, evaluate, verify, and route approval exactly as the API would. Returns null when stopped. */
function check(run: Run, s: Setup, m: Mandate, c: Case, v: Vault): Checked | null {
  const action = makeAction(s, c, run.t);
  const actionHash = canonicalHash(action);
  const signature = signProposal(actionHash, s.agentSk);
  const first = run.emit('ActionProposed', action.id, { action, action_hash: actionHash, agent_signature: signature }, 1_500);
  let report: Checked['report'] = null;
  let round = 0;
  const evaluateNow = () => {
    run.emit('AuthorityEvaluationStarted', action.id, { mandate_id: m.id, mandate_version: m.version }, 300);
    const evaluation = evaluate({
      mandate: m,
      proposal: { action, agent_signature: signature },
      state: {
        vault_balance: v.balance.toString(),
        spent_today: v.spent.toString(),
        day_index: Math.floor(run.t / DAY_MS),
        last_nonce: v.nonce.toString(),
        anchor_version: m.version,
        anchor_status: 'active',
        observed_at_slot: 1,
      },
      verification: report && { report: report.report, report_hash: report.report_hash, block_time_ms: run.t - 2_000 },
      nowMs: run.t,
    });
    run.emit('AuthorityEvaluated', action.id, { evaluation }, 200);
    return evaluation;
  };
  let evaluation = evaluateNow();
  if (evaluation.outcome === 'NEEDS_VERIFICATION') {
    report = cre(run, action, actionHash, ++round);
    evaluation = evaluateNow();
  }
  if (evaluation.outcome === 'DENY') {
    const reason = evaluation.reason as ReasonCode;
    const layer: Layer = FACT_REASONS.has(reason) ? 'cre' : 'engine';
    run.emit('ActionDenied', action.id, { reason, layer });
    return null;
  }
  let approved = false;
  if (evaluation.outcome === 'REQUIRE_APPROVAL') {
    const approval_id = `AP-${action.id}`;
    run.emit('ApprovalRequested', action.id, { approval_id, approvals_required: evaluation.approvals_required });
    out.approvals.push({ approval_id, run_id: run.id, action, evaluation, requested_at: new Date(run.t).toISOString() });
    if (c.cfo === 'decline') {
      run.emit('CFODeclined', action.id, { approval_id }, 8_000);
      return null;
    }
    run.emit('CFOApproved', action.id, { approval_id, cfo_key_hash: CFO_TEST }, 8_000);
    report = cre(run, action, actionHash, ++round);
    evaluation = evaluateNow();
    if (evaluation.outcome === 'DENY') throw new Error(`fixture ${action.id}: denied after CFO approval (${evaluation.reason}); refusing to authorize`);
    approved = true;
  }
  return { action, actionHash, signature, evaluation, report, approved, firstEventHash: first.hash };
}

function authorize(
  run: Run,
  s: Setup,
  m: Mandate,
  v: Vault,
  actionId: string,
  terms: { actionHash: string; amount: string; recipient: string; requiresPrincipal: boolean; verificationRef: string | null; validUntil?: number },
  compromised = false,
): AuthorizationRecord {
  v.nonce += 1n;
  const authorization = signAuthorization(
    {
      chainTag: 0,
      vaultHash: s.vaultHash,
      mandateRef: s.mandateRef,
      mandateHash: mandateHash(m),
      mandateVersion: m.version,
      actionHash: terms.actionHash,
      actionType: 1,
      assetPolicy: ASSET.policy,
      assetName: ASSET.name,
      amount: BigInt(terms.amount),
      recipient: terms.recipient,
      nonce: v.nonce,
      validUntil: BigInt(terms.validUntil ?? run.t + 600_000),
      requiresPrincipal: terms.requiresPrincipal,
      verificationRef: terms.verificationRef,
    },
    s.engineSk,
  );
  run.emit('AuthorizationIssued', actionId, { authorization, compromised_engine: compromised }, 200);
  return authorization;
}

/** The last event already in the log: what a transaction built now can commit (it cannot name itself). */
const headOf = (run: Run): LogHead => {
  const last = run.events[run.events.length - 1] as RunEvent;
  return { seq: last.seq, hash: last.hash };
};

function mandateAnchorInput(s: Setup, m: Mandate): KoiosTx['reference_inputs'][number] {
  const l = s.limits;
  return {
    payment_addr: { bech32: '', cred: s.mandateRef },
    asset_list: [{ policy_id: s.mandateRef, asset_name: MANDATE_TOKEN_HEX, quantity: '1' }],
    inline_datum: {
      bytes: null,
      value: {
        constructor: 0,
        fields: [
          { bytes: mandateHash(m) },
          { int: m.version },
          { constructor: 0, fields: [] },
          { bytes: pk(s.engineSk) },
          { bytes: CFO_TEST },
          { bytes: ASSET.policy },
          { bytes: ASSET.name },
          { int: Number(l.autonomous_limit) },
          { int: Number(l.hard_cap) },
          { int: Number(l.daily_cap) },
          { int: Number(l.treasury_minimum) },
          { int: Date.parse(m.validity.expires_at) },
        ],
      },
    },
  };
}

/** Koios tx_info for a transaction that only carries metadata label 1694. */
const metadataTx = (tx: string, height: number, metadata: Record<string, unknown>, refs: KoiosTx['reference_inputs'] = []): KoiosTx => ({
  tx_hash: tx,
  block_height: height,
  reference_inputs: refs,
  outputs: [],
  plutus_contracts: [],
  metadata: { '1694': metadata },
});

function settle(run: Run, actionId: string, rec: AuthorizationRecord, v: Vault): { tx: string; block: number; head: LogHead } {
  const tx = txid(`${run.id}:${actionId}`);
  const head = headOf(run);
  run.emit('TransactionBuilt', actionId, { tx_hash: tx, tx_body_cbor: fakeBody(tx), log_head: head }, 400);
  run.emit('TransactionSubmitted', actionId, { tx_hash: tx }, 900);
  block += 1;
  run.emit('TransactionConfirmed', actionId, { tx_hash: tx, block_height: block }, 21_000);
  out.koios[tx] = metadataTx(tx, block, { log_head: head });
  v.balance -= BigInt(rec.fields.amount);
  v.spent += BigInt(rec.fields.amount);
  return { tx, block, head };
}

/** Closing anchor: one transaction per finished run whose metadata 1694 commits the head at the run's last event. */
function close(run: Run, s: Setup, m: Mandate) {
  const tx = txid(`close:${run.id}`);
  const head = headOf(run);
  const signature = signEvidenceAnchor(run.id, head.seq, head.hash, s.engineSk);
  block += 1;
  out.koios[tx] = metadataTx(tx, block, { log_head: head, signature }, [mandateAnchorInput(s, m)]);
  out.anchors[run.id] = { tx_hash: tx, ...head };
}

function reject(run: Run, actionId: string, invariant: string): string {
  const tx = txid(`${run.id}:${actionId}:attempt`);
  run.emit('TransactionBuilt', actionId, { tx_hash: tx, tx_body_cbor: fakeBody(tx), log_head: headOf(run) }, 400);
  run.emit(
    'TransactionRejected',
    actionId,
    { tx_hash: tx, invariant, error: `script evaluation failed: ${invariant}`, tx_body_cbor: fakeBody(tx) },
    2_500,
  );
  return tx;
}

function prove(run: Run, s: Setup, m: Mandate, k: Checked, rec: AuthorizationRecord, settled: { tx: string; block: number; head: LogHead }, n: number) {
  const last = run.events[run.events.length - 1] as RunEvent;
  const receipt: Receipt = {
    schema: 'receipt/v0.1',
    principal: m.principal.name,
    delegate: 'CFO-Agent-01',
    mandate: { id: m.id, version: m.version, hash: mandateHash(m), anchor: s.mandateRef },
    action: { ir: k.action, hash: k.actionHash, agent_signature: k.signature },
    evaluation: { outcome: k.evaluation.outcome, reason: k.evaluation.reason, checks: k.evaluation.checks },
    verification: k.report && {
      id: `V-${String(n).padStart(4, '0')}`,
      report_hash: k.report.report_hash,
      sepolia_tx: k.report.sepolia_tx,
      result: k.report.report.result,
    },
    authorization: {
      id: `Z-${String(n).padStart(4, '0')}`,
      verification_id: k.report ? `V-${String(n).padStart(4, '0')}` : null,
      digest: rec.digest_hex,
      signature: rec.signature_hex,
      engine_public_key: rec.engine_public_key,
      nonce: rec.fields.nonce,
      valid_until: rec.fields.valid_until,
    },
    approval: { required: k.approved, cfo_key_hash: k.approved ? CFO_TEST : null },
    settlement: { chain: 'cardano-preprod', tx_hash: settled.tx, block: settled.block },
    masumi: null,
    evidence: { first_event_hash: k.firstEventHash, last_event_hash: last.hash },
  };
  const receipt_id = `R-${String(n).padStart(4, '0')}`;
  const receipt_hash = canonicalHash(receipt);
  out.bundles[receipt_id] = { receipt, receipt_hash, authorization: rec, mandate: m };
  out.receipts.push({
    receipt_id,
    action_id: k.action.id,
    counterparty: k.action.counterparty.display,
    amount: k.action.amount.value,
    settled_tx: settled.tx,
    created_at: new Date(run.t).toISOString(),
  });
  out.koios[settled.tx] = {
    tx_hash: settled.tx,
    block_height: settled.block,
    reference_inputs: [mandateAnchorInput(s, m)],
    outputs: [
      {
        payment_addr: { bech32: rec.fields.recipient, cred: '' },
        asset_list: [{ policy_id: ASSET.policy, asset_name: ASSET.name, quantity: rec.fields.amount }],
        inline_datum: null,
      },
    ],
    plutus_contracts: [
      {
        script_hash: s.vaultHash,
        valid_contract: true,
        input: {
          redeemer: {
            purpose: 'spend',
            datum: { value: { constructor: 0, fields: [{ constructor: 0, fields: [{ bytes: rec.fields.action_hash }] }, { bytes: rec.signature_hex }] } },
          },
        },
      },
    ],
    metadata: { '1694': { auth: rec.digest_hex, action: k.actionHash, mandate: `${m.id}@${m.version}`, log_head: settled.head } },
  };
  run.emit('ReceiptProven', k.action.id, { receipt_id, receipt_hash }, 500);
}

function mandateView(s: Setup, m: Mandate, v: Vault, status: 'active' | 'revoked' = 'active'): MandateView {
  return {
    mandate: m,
    mandate_hash: mandateHash(m),
    limits: s.limits,
    anchor: { mandate_ref: s.mandateRef, version: m.version, status, tx_hash: txid(`anchor:${s.id}:${m.version}`) },
    vault: {
      vault_hash: s.vaultHash,
      balance: v.balance.toString(),
      spent_today: v.spent.toString(),
      day_index: Math.floor(T0 / DAY_MS),
      last_nonce: v.nonce.toString(),
      tx_hash: txid(`vault:${s.id}:${v.nonce}`),
    },
  };
}

// ---- stage run (scaled amounts) -----------------------------------------------
{
  const m = buildMandate(M001);
  const v: Vault = { balance: BigInt(u(M001.start)), spent: 0n, nonce: 0n };
  const run = new Run('run-stage-0001', T0);
  started(run, M001, m, v, 'stage', "Process today's open vendor invoices", null);
  const cases: Case[] = [
    { id: 'A-0001', amount: '8.42', invoice: 'INV-3821', rationale: 'Invoice INV-3821 is open and matches an approved cloud expense.' },
    { id: 'A-0002', amount: '18.00', invoice: 'INV-3822', cfo: 'approve', rationale: 'INV-3822 covers the monthly reserved compute commitment.' },
    {
      id: 'A-0003',
      amount: '5.00',
      invoice: 'INV-G-0042',
      counterparty: ['globex', 'Globex (demo vendor)'],
      recipient: ADDR.globex,
      cfo: 'decline',
      rationale: 'Globex sent an invoice for consulting hours.',
    },
    { id: 'A-0004', amount: '60.00', invoice: 'INV-3825', rationale: 'INV-3825 is the annual support plan.' },
    {
      id: 'A-0005',
      amount: '2.00',
      invoice: null,
      type: 'purchase',
      purpose: 'digital_collectibles',
      counterparty: ['nft-marketplace', 'NFT marketplace'],
      recipient: ADDR.nft,
      rationale: 'A collectible would make a good brand asset.',
    },
    {
      id: 'A-0006',
      amount: '4.00',
      invoice: 'INV-3823',
      recipient: ADDR.attacker,
      rationale: 'AWS billing emailed that their bank changed; paying INV-3823 to the new address.',
    },
    { id: 'A-0007', amount: '9.00', invoice: 'INV-3824', rationale: 'INV-3824 is open for storage overage.' },
  ];
  let n = 0;
  for (const c of cases) {
    const k = check(run, M001, m, c, v);
    if (!k) continue;
    const rec = authorize(run, M001, m, v, k.action.id, {
      actionHash: k.actionHash,
      amount: k.action.amount.value,
      recipient: k.action.recipient.address,
      requiresPrincipal: k.approved,
      verificationRef: k.report?.report_hash ?? null,
    });
    if (k.approved) out.approve[`AP-${k.action.id}`] = { authorization: rec, unsigned_tx_cbor: fakeBody(`unsigned:${k.action.id}`), tx_hash: txid(`${run.id}:${k.action.id}`) };
    const settled = settle(run, k.action.id, rec, v);
    prove(run, M001, m, k, rec, settled, ++n);
  }
  close(run, M001, m);
  out.logs[run.id] = run.events;
  out.mandates['M-001'] = mandateView(M001, m, v);
  // keep only the approval that is still pending in a fresh inbox (case 2, before the CFO acted)
  out.approvals = out.approvals.filter((a) => a.approval_id === 'AP-A-0002');
}

// ---- Attack Lab runs against M-LAB ---------------------------------------------------------------
const LAB_ATTACKS: AttackId[] = [
  'prompt_injection',
  'prompt_injection_direct',
  'recipient_swap',
  'amount_swap',
  'replay',
  'expired',
  'revoked',
  'daily_cap',
  'cfo_bypass',
];
let labVault: Vault = { balance: 0n, spent: 0n, nonce: 0n };
for (const attack of LAB_ATTACKS) {
  const m = buildMandate(MLAB);
  const v: Vault = { balance: BigInt(u(MLAB.start)), spent: 0n, nonce: 0n };
  const run = new Run(`run-lab-${attack}`, T0 + 3_600_000 + LAB_ATTACKS.indexOf(attack) * 600_000);
  started(run, MLAB, m, v, 'lab', `Attack Lab: ${attack.replaceAll('_', ' ')}`, attack);
  run.emit('AttackStarted', null, { attack, mandate_id: m.id });
  const valid = (id: string, amount = '0.50') =>
    check(run, MLAB, m, { id, amount, invoice: 'INV-L-0001', rationale: 'Lab invoice INV-L-0001 is open.' }, v);
  const result = (stopped_by: Layer, code: string, tx_hash: string | null) =>
    run.emit('AttackResult', null, { attack, stopped_by, code, funds_moved: '0', tx_hash });
  const authFor = (k: Checked, validUntil?: number) =>
    authorize(run, MLAB, m, v, k.action.id, {
      actionHash: k.actionHash,
      amount: k.action.amount.value,
      recipient: k.action.recipient.address,
      requiresPrincipal: false,
      verificationRef: k.report?.report_hash ?? null,
      ...(validUntil === undefined ? {} : { validUntil }),
    });
  const forged = (id: string, amount: string) =>
    authorize(
      run,
      MLAB,
      m,
      v,
      id,
      { actionHash: sha256Hex(`forged:${id}`), amount: u(amount), recipient: ADDR.aws, requiresPrincipal: false, verificationRef: null },
      true,
    );

  switch (attack) {
    case 'prompt_injection':
    case 'prompt_injection_direct': {
      check(
        run,
        MLAB,
        m,
        {
          id: `LAB-${attack}`,
          amount: '0.40',
          invoice: 'INV-L-0007',
          recipient: ADDR.attacker,
          rationale: 'URGENT from AWS billing: our bank changed. Paying INV-L-0007 to the new address.',
        },
        v,
      );
      result('cre', 'RECIPIENT_MISMATCH', null);
      break;
    }
    case 'recipient_swap':
    case 'amount_swap':
    case 'expired': {
      const k = valid(`LAB-${attack}`) as Checked;
      authFor(k, attack === 'expired' ? run.t - 60_000 : undefined);
      const code = attack === 'recipient_swap' ? 'R16' : attack === 'amount_swap' ? 'R6' : 'R7';
      result('vault', code, reject(run, k.action.id, code));
      break;
    }
    case 'replay': {
      const k = valid('LAB-replay-1') as Checked;
      const rec = authFor(k);
      settle(run, k.action.id, rec, v);
      run.emit('AuthorizationIssued', 'LAB-replay-2', { authorization: rec, compromised_engine: false }, 1_000);
      result('vault', 'R8', reject(run, 'LAB-replay-2', 'R8'));
      break;
    }
    case 'revoked': {
      const k = valid('LAB-revoked') as Checked;
      authFor(k);
      run.emit('MandateUpdated', null, { mandate_id: m.id, version: m.version + 1, tx_hash: txid(`anchor:${m.id}:${m.version + 1}`) }, 20_000);
      result('vault', 'R4', reject(run, k.action.id, 'R4'));
      break;
    }
    case 'daily_cap': {
      for (let i = 1; i <= 5; i++) settle(run, `LAB-daily-${i}`, forged(`LAB-daily-${i}`, '0.90'), v);
      forged('LAB-daily-6', '0.90');
      result('vault', 'R12', reject(run, 'LAB-daily-6', 'R12'));
      break;
    }
    case 'cfo_bypass': {
      forged('LAB-cfo-bypass', '1.80');
      result('vault', 'R11', reject(run, 'LAB-cfo-bypass', 'R11'));
      break;
    }
  }
  // run-lab-replay keeps no closing anchor: it is verified only through its own settlement's head.
  if (attack !== 'replay') close(run, MLAB, m);
  out.logs[run.id] = run.events;
  labVault = v;
}
out.mandates['M-LAB'] = mandateView(MLAB, buildMandate(MLAB), labVault);
out.mandates['M-REVOKED'] = mandateView(MREV, buildMandate(MREV), { balance: BigInt(u(MREV.start)), spent: 0n, nonce: 0n }, 'revoked');
for (const r of out.runs) r.event_count = out.logs[r.run_id]?.length ?? 0;

writeFileSync(new URL('../fixtures/recorded.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(
  `fixtures/recorded.json: ${out.runs.length} runs, ${seq} events, ${Object.keys(out.bundles).length} receipts, chain head ${prev.slice(0, 16)}…`,
);
