import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { VerificationOutcome } from '@authority/chainlink';
import {
  type ActionIR,
  type AuthorizationRecord,
  bytesToHex,
  canonicalHash,
  type ChainBinding,
  type EscalationPrice,
  type Mandate,
  mandateHash,
  parseMandate,
  publicKeyFromSecret,
  sha256Hex,
  signProposal,
  type VerificationReport,
} from '@authority/core';
import { memoryDb } from '@authority/db/testing';
import { MeshWallet } from '@meshsdk/core';
import { createApp } from '../src/app';
import type { Engine } from '../src/check';
import { createExecutor } from '../src/executor';
import { createLog } from '../src/log';
import { BOND_LOCK_MS } from '../src/escalation';
import { insertMandate } from '../src/mandates';
import { type BondOutcome, type BondUtxo, CardanoError, type CardanoPort, type LabDeps, type SettlementMetadata } from '../src/ports';

// Fixed TEST keys (no funds anywhere). The CFO is a Mesh wallet from a fixed CLI signing key, so CIP-8 and
// CIP-30 witnesses in tests come from a real wallet implementation.
export const ENGINE_SK = new Uint8Array(32).fill(1);
export const AGENT_SK = new Uint8Array(32).fill(2);
export const LAB_ENGINE_SK = new Uint8Array(32).fill(3);
export const LAB_AGENT_SK = new Uint8Array(32).fill(4);
export const CFO_SIGNING_KEY_CBOR = `5820${'07'.repeat(32)}`;
/** The organization's admin key hash on the anchor (mandate changes); distinct from the approver (CFO) key. */
export const ADMIN_PKH = 'ad'.repeat(28);
const pk = (sk: Uint8Array) => bytesToHex(publicKeyFromSecret(sk));

export const ADDR = {
  aws: 'addr_test1vzs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggfw5wvl',
  globex: 'addr_test1vzet9v4jk2et9v4jk2et9v4jk2et9v4jk2et9v4jk2et9vspneuyz',
  attacker: 'addr_test1vrpu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8sclmre6l',
  nft: 'addr_test1vr2df4x56n2df4x56n2df4x56n2df4x56n2df4x56n2df4qmrdj2c',
};
export const NOW = Date.parse('2026-10-07T03:00:00.000Z');
export const DAY = Math.floor(NOW / 86_400_000);
export const AGENT_KEY = 'agent-key-0123456789abcdef0123456789';
export const MASUMI_KEY = 'masumi-key-0123456789abcdef012345678';
export const RELAY_KEY = 'relay-key-0123456789abcdef0123456789';
export const WEB = 'http://localhost:3100';
export const usdm = (dollars: string) => (BigInt(Math.round(Number(dollars) * 100)) * 10_000n).toString();

let cfo: Promise<{ wallet: MeshWallet; address: string; pkh: string }> | null = null;
export function cfoWallet() {
  cfo ??= (async () => {
    const wallet = new MeshWallet({ networkId: 0, key: { type: 'cli', payment: CFO_SIGNING_KEY_CBOR } });
    await wallet.init();
    const address = await wallet.getChangeAddress();
    const { deserializeAddress } = await import('@meshsdk/core');
    return { wallet, address, pkh: deserializeAddress(address).pubKeyHash };
  })();
  return cfo;
}

export function mandate(o: { id: string; version: number; engine: Uint8Array; agent: Uint8Array; cfoPkh: string; limits: [string, string, string, string]; vendors: string[] }): Mandate {
  const [autonomous, hard, daily, floor] = o.limits.map(usdm) as [string, string, string, string];
  return parseMandate({
    schema: 'mandate/v0.1',
    id: o.id,
    version: o.version,
    status: 'active',
    principal: { type: 'organization', id: 'acme', name: 'Acme Corp', cardano_key_hash: ADMIN_PKH },
    delegate: { type: 'agent', id: 'cfo-agent-01', public_key: `ed25519:${pk(o.agent)}` },
    approvers: [{ role: 'CFO', cardano_key_hash: o.cfoPkh }],
    authority_engine: { public_key: `ed25519:${pk(o.engine)}` },
    asset: { symbol: 'USDM', decimals: 6 },
    validity: { starts_at: '2026-10-06T00:00:00Z', expires_at: '2026-11-06T00:00:00Z' },
    delegation: { allowed: false },
    interrupt_budget: { per_day: 3 },
    constraints: [
      { id: 'purpose', kind: 'purpose_in', values: ['invoice_payment'], on_violation: 'DENY' },
      { id: 'action', kind: 'action_in', values: ['pay_invoice'], on_violation: 'DENY' },
      { id: 'asset', kind: 'asset_eq', value: 'USDM', on_violation: 'DENY' },
      { id: 'counterparty', kind: 'counterparty_in', values: o.vendors, on_violation: 'ESCALATE', approver: 'CFO' },
      { id: 'autonomous', kind: 'amount_lte', value: autonomous, on_violation: 'ESCALATE', approver: 'CFO' },
      { id: 'hard_cap', kind: 'amount_lte', value: hard, on_violation: 'DENY' },
      { id: 'daily_cap', kind: 'daily_spend_lte', value: daily, on_violation: 'DENY' },
      { id: 'treasury_floor', kind: 'balance_after_gte', value: floor, on_violation: 'DENY' },
      { id: 'invoice_facts', kind: 'verified_facts', source: 'stripe', on_violation: 'DENY' },
    ],
  });
}

export const binding = (vault: string, ref: string): ChainBinding => ({
  chainTag: 0,
  vaultHash: vault.repeat(28),
  mandateRef: ref.repeat(28),
  assetPolicy: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde',
  assetName: '0014df10745553444d',
  assetSymbol: 'USDM',
});

// ---- Stripe stand-in: the vendor billing network ------------------------------------------------
export interface Invoice {
  id: string;
  number: string;
  amount: string;
  payout: string;
  status: 'open' | 'paid';
}
export const STAGE_INVOICES: Invoice[] = [
  ['in_3821', 'INV-3821', '8.42', ADDR.aws],
  ['in_3822', 'INV-3822', '18.00', ADDR.aws],
  ['in_g0042', 'INV-G-0042', '5.00', ADDR.globex],
  ['in_3825', 'INV-3825', '60.00', ADDR.aws],
  ['in_3823', 'INV-3823', '4.00', ADDR.aws],
  ['in_3824', 'INV-3824', '9.00', ADDR.aws],
  ['in_l0001', 'INV-L-0001', '0.50', ADDR.aws],
].map(([id, number, amount, payout]) => ({ id: id!, number: number!, amount: usdm(amount!), payout: payout!, status: 'open' as const }));

// ---- CRE stand-in: what verifyInvoice returns after reading the report back from Sepolia ---------
export function fakeVerify(invoices: Map<string, Invoice>, now: () => number) {
  const calls: { action: ActionIR; triggerId: string }[] = [];
  let unavailable: string | null = null;
  const verify = async (action: ActionIR, triggerId: string): Promise<VerificationOutcome> => {
    calls.push({ action, triggerId });
    if (unavailable) return { status: 'unavailable', error: unavailable };
    const inv = invoices.get(action.reference!.invoice_id);
    const facts = {
      exists: inv !== undefined,
      customer_match: inv !== undefined,
      status_open: inv?.status === 'open',
      amount_match: inv?.amount === action.amount.value,
      currency_match: inv !== undefined,
      recipient_match: inv?.payout === action.recipient.address,
    };
    const order = [
      ['exists', 'INVOICE_NOT_FOUND'],
      ['customer_match', 'CUSTOMER_MISMATCH'],
      ['status_open', 'INVOICE_NOT_OPEN'],
      ['amount_match', 'AMOUNT_MISMATCH'],
      ['currency_match', 'CURRENCY_MISMATCH'],
      ['recipient_match', 'RECIPIENT_MISMATCH'],
    ] as const;
    const failed = order.find(([k]) => !facts[k]);
    const report: VerificationReport = {
      schema: 'verification/v0.1',
      action_hash: canonicalHash(action),
      invoice_id: action.reference!.invoice_id,
      invoice_hash: sha256Hex(`invoice:${action.reference!.invoice_id}`),
      verified_amount: inv?.amount ?? null,
      verified_currency: inv ? 'usd' : null,
      verified_recipient: inv?.payout ?? null,
      status: inv?.status ?? null,
      facts,
      result: failed ? 'MISMATCH' : 'VERIFIED',
      reason: failed ? failed[1] : null,
      trigger_id: triggerId,
    };
    return {
      status: 'reported',
      verified: { report, report_hash: canonicalHash(report), block_time_ms: now() - 5_000 },
      tx_hash: `0x${sha256Hex(`sepolia:${triggerId}`)}`,
    };
  };
  return { verify, calls, setUnavailable: (why: string | null) => void (unavailable = why) };
}

// ---- Cardano stand-in: one vault and one anchor per binding, enforcing the vault rules tests rely on ----
export interface Chain {
  balance: bigint;
  spent: bigint;
  day: number;
  lastNonce: bigint;
  utxo: string;
  anchorVersion: number;
  anchorHash: string;
  anchorStatus: 'active' | 'revoked';
  /** Admin key hash in the anchor datum. */
  principal: string;
  /** Approver (CFO) key hash in the anchor datum. */
  approver: string;
}

export function fakeCardano(chains: Map<string, Chain>, now: () => number) {
  const txs = new Map<string, { vault: string; auth: AuthorizationRecord; metadata: SettlementMetadata; cfo: string | null; utxo: string }>();
  const anchorTxs = new Map<string, { vault: string; kind: 'update' | 'revoke'; mandate: Mandate | null }>();
  const built: { metadata: SettlementMetadata; txHash: string; cfo: string | null }[] = [];
  const executed = new Map<string, string>(); // authorization digest -> tx that paid its recipient
  let height = 5_000_000;
  const faults: CardanoError[] = [];
  // Fake escrow: bonds the test locked, keyed by approval id; spends built by outcome.
  const bonds = new Map<string, BondUtxo>();
  const bondSpends = new Map<string, { bond: BondUtxo; outcome: BondOutcome }>();
  let reads = 0;
  let readsFail = false;
  const chain = (b: { vaultHash: string }) => {
    const c = chains.get(b.vaultHash);
    if (!c) throw new Error('unknown vault');
    return c;
  };
  const port: CardanoPort = {
    async readVaultState(b) {
      reads += 1;
      if (readsFail) throw new Error('blockfrost timeout');
      const c = chain(b);
      return { balance: c.balance, spent_today: c.spent, day_index: c.day, last_nonce: c.lastNonce, tx_hash: c.utxo, slot: 1 };
    },
    async readAnchor(b) {
      if (readsFail) throw new Error('blockfrost timeout');
      const c = chain(b);
      return {
        mandate_hash: c.anchorHash,
        version: c.anchorVersion,
        status: c.anchorStatus,
        principal_pkh: c.principal,
        approver_pkh: c.approver,
        tx_hash: 'ab'.repeat(32),
      };
    },
    async buildRelease({ binding: b, authorization, metadata, cfoKeyHash }) {
      const c = chain(b);
      const txHash = sha256Hex(`release:${c.utxo}:${authorization.digest_hex}`);
      txs.set(txHash, { vault: b.vaultHash, auth: authorization, metadata, cfo: cfoKeyHash, utxo: c.utxo });
      built.push({ metadata, txHash, cfo: cfoKeyHash });
      return { txCbor: `84a4${txHash}`, txHash };
    },
    bondAddresses() {
      return { escrow: 'addr_test1wq' + 'e5c4'.repeat(12) + 'ab', sink: 'addr_test1wq' + 'dead'.repeat(12) + 'ab' };
    },
    async readBond(price) {
      const bond = bonds.get(price.approval_id);
      if (!bond || bond.datum.action_hash !== price.action_hash || bond.amount !== BigInt(price.amount)) return null;
      return bond;
    },
    async buildBondSpend(bond, outcome) {
      const txHash = sha256Hex(`bond:${outcome}:${bond.tx_hash}#${bond.output_index}`);
      bondSpends.set(txHash, { bond, outcome });
      return { txCbor: `84a4${txHash}`, txHash };
    },
    async buildAnchorUpdate({ binding: b, mandate: m }) {
      const txHash = sha256Hex(`update:${m.version}:${b.mandateRef}`);
      anchorTxs.set(txHash, { vault: b.vaultHash, kind: 'update', mandate: m });
      return { txCbor: `84a4${txHash}`, txHash };
    },
    async buildAnchorRevoke({ binding: b }) {
      const txHash = sha256Hex(`revoke:${b.mandateRef}:${chain(b).anchorVersion}`);
      anchorTxs.set(txHash, { vault: b.vaultHash, kind: 'revoke', mandate: null });
      return { txCbor: `84a4${txHash}`, txHash };
    },
    async submit({ txCbor, witnessSets }) {
      const fault = faults.shift();
      if (fault) throw fault;
      const txHash = txCbor.slice(4);
      const spend = bondSpends.get(txHash);
      if (spend) {
        // Escrow validator: Refund needs the approver's signature or a validity range past locked_until; Capture the signature.
        if (witnessSets.length === 0 && (spend.outcome === 'capture' || now() <= spend.bond.datum.locked_until_ms)) {
          throw new CardanoError('SCRIPT_FAILED', 'bond: approver signature required', 'BOND', txCbor);
        }
        for (const [k, b] of bonds) if (b.tx_hash === spend.bond.tx_hash) bonds.delete(k);
        return txHash;
      }
      const anchor = anchorTxs.get(txHash);
      if (anchor) {
        const c = chains.get(anchor.vault)!;
        if (witnessSets.length === 0) throw new CardanoError('SCRIPT_FAILED', 'u1 ? False', 'U1', txCbor);
        c.anchorVersion += 1;
        if (anchor.kind === 'revoke') c.anchorStatus = 'revoked';
        else c.anchorHash = mandateHash(anchor.mandate!);
        return txHash;
      }
      const tx = txs.get(txHash);
      if (!tx) throw new CardanoError('SUBMIT_FAILED', 'unknown tx');
      const c = chains.get(tx.vault)!;
      if (tx.utxo !== c.utxo) throw new CardanoError('CONTENTION', 'vault input already spent', null, txCbor);
      const f = tx.auth.fields;
      if (BigInt(f.nonce) <= c.lastNonce) throw new CardanoError('SCRIPT_FAILED', 'r8 ? False', 'R8', txCbor);
      if (f.requires_principal && !witnessSets.some((w) => w.length > 0)) throw new CardanoError('SCRIPT_FAILED', 'r11 ? False', 'R11', txCbor);
      const day = Math.floor(now() / 86_400_000);
      const spent = (day > c.day ? 0n : c.spent) + BigInt(f.amount);
      c.balance -= BigInt(f.amount);
      c.spent = spent;
      c.day = day;
      c.lastNonce = BigInt(f.nonce);
      c.utxo = `${txHash}#0`;
      executed.set(tx.auth.digest_hex, txHash);
      return txHash;
    },
    async awaitConfirmation() {
      height += 1;
      return { block_height: height };
    },
    async releaseOf(_b, authorization) {
      return executed.get(authorization.digest_hex) ?? null;
    },
  };
  return {
    port,
    built,
    bonds,
    bondSpends,
    /** The agent locked the priced bond in escrow: the UTxO the port will read back for this approval. */
    lockBond(price: EscalationPrice, o: { amount?: bigint; agent?: string } = {}): BondUtxo {
      const utxo: BondUtxo = {
        tx_hash: sha256Hex(`bond:lock:${price.approval_id}:${price.action_hash}`),
        output_index: 0,
        amount: o.amount ?? BigInt(price.amount),
        escrow_address: price.escrow_address,
        datum: {
          approval_ref: sha256Hex(price.approval_id),
          action_hash: price.action_hash,
          mandate_ref: 'bb'.repeat(28),
          agent_pkh: o.agent ?? 'a6'.repeat(28),
          agent_stake: null,
          approver_pkh: price.approver_key_hash,
          amount: o.amount ?? BigInt(price.amount),
          locked_until_ms: price.locked_until_ms,
        },
      };
      bonds.set(price.approval_id, utxo);
      return utxo;
    },
    fault: (e: CardanoError) => void faults.push(e),
    reads: () => reads,
    failReads: (v: boolean) => void (readsFail = v),
    /** Someone else (e.g. a Masumi buyer holding the record) executed this authorization on-chain. */
    executeExternally: (vaultHash: string, record: AuthorizationRecord) => {
      const c = chains.get(vaultHash)!;
      c.lastNonce = BigInt(record.fields.nonce);
      c.balance -= BigInt(record.fields.amount);
      c.utxo = `external${record.fields.nonce}#0`;
      executed.set(record.digest_hex, sha256Hex(`external:${record.digest_hex}`));
    },
    /** Another release settles first: the vault UTxO moves and last_nonce advances. */
    contend: (vaultHash: string, nonce: bigint) => {
      const c = chains.get(vaultHash)!;
      c.utxo = `contender${nonce}#0`;
      c.lastNonce = nonce;
    },
  };
}

// ---- The API under test ---------------------------------------------------------------------------
export async function startApi(o: { labRunner?: LabDeps['runner']; interpret?: Engine['interpret'] } = {}) {
  let t = NOW;
  const now = () => t;
  const db = await memoryDb();
  const { pkh } = await cfoWallet();
  const m001 = mandate({ id: 'M-001', version: 3, engine: ENGINE_SK, agent: AGENT_SK, cfoPkh: pkh, limits: ['10', '50', '50', '100'], vendors: ['aws', 'stripe'] });
  const mlab = mandate({ id: 'M-LAB', version: 1, engine: LAB_ENGINE_SK, agent: LAB_AGENT_SK, cfoPkh: pkh, limits: ['1', '5', '5', '1'], vendors: ['aws'] });
  const b001 = binding('aa', 'bb');
  const blab = binding('a2', 'b2');
  await insertMandate(db, m001, b001, 'CFO-Agent-01', 'stage');
  await insertMandate(db, mlab, blab, 'CFO-Agent-01', 'lab');
  const chainOf = (m: Mandate, balance: string): Chain => ({
    balance: BigInt(usdm(balance)),
    spent: 0n,
    day: DAY,
    lastNonce: 0n,
    utxo: `genesis-${m.id}#0`,
    anchorVersion: m.version,
    anchorHash: mandateHash(m),
    anchorStatus: 'active',
    principal: ADMIN_PKH,
    approver: pkh,
  });
  const chains = new Map([
    [b001.vaultHash, chainOf(m001, '135')],
    [blab.vaultHash, chainOf(mlab, '10')],
  ]);
  const cardano = fakeCardano(chains, now);
  const invoices = new Map(STAGE_INVOICES.map((i) => [i.id, { ...i }]));
  const cre = fakeVerify(invoices, now);
  const settled: { invoiceId: string; txHash: string }[] = [];
  const log = createLog(db, now);
  const executor = createExecutor({
    db,
    log,
    now,
    cardano: cardano.port,
    settle: async (invoiceId, txHash) => {
      settled.push({ invoiceId, txHash });
      invoices.get(invoiceId)!.status = 'paid';
    },
  });
  const invoiceReads: string[] = [];
  const eng: Engine = {
    db,
    log,
    now,
    cardano: cardano.port,
    verify: cre.verify,
    readInvoice: async (id) => {
      invoiceReads.push(id);
      const inv = invoices.get(id);
      return inv ? { number: inv.number } : null;
    },
    engineKeys: new Map([
      ['M-001', ENGINE_SK],
      ['M-LAB', LAB_ENGINE_SK],
    ]),
    enqueue: (id) => executor.enqueue(id),
    interpret: o.interpret ?? null,
    publicApiUrl: 'https://api.test',
    bondLovelace: '5000000',
  };
  const lab: LabDeps = {
    runner: o.labRunner ?? null,
    keys: { engine: LAB_ENGINE_SK, agent: LAB_AGENT_SK },
    invoice: async (number) => {
      const inv = [...invoices.values()].find((i) => i.number === number && i.status === 'open');
      return inv ? { id: inv.id, amount_usdm: inv.amount, payout_address: inv.payout } : null;
    },
  };
  const server = createServer(createApp({ eng, lab, keys: { agent: AGENT_KEY, masumi: MASUMI_KEY, relay: RELAY_KEY }, webOrigins: [WEB] }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as any) : null };
  };
  let keyN = 0;
  /** PAYMENT-SIGNATURE for a bond the fake chain holds. */
  const paymentHeader = (accepted: unknown, price: EscalationPrice, utxo: { tx_hash: string; output_index: number }) =>
    Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { approval_id: price.approval_id, tx_hash: utxo.tx_hash, output_index: utxo.output_index } })).toString('base64');
  /** fetch that pays a 402 the way the agent does: lock the priced bond, retry with PAYMENT-SIGNATURE. */
  const x402Fetch: typeof fetch = async (input, init) => {
    const first = await fetch(input, init);
    if (first.status !== 402) return first;
    const required = JSON.parse(await first.text()) as { accepts: Array<{ extra: EscalationPrice }> };
    const accepted = required.accepts[0]!;
    const utxo = cardano.lockBond(accepted.extra);
    return fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), 'payment-signature': paymentHeader(accepted, accepted.extra, utxo) } });
  };
  const api = {
    url,
    db,
    eng,
    executor,
    cardano,
    cre,
    invoices,
    invoiceReads,
    settled,
    m001,
    mlab,
    b001,
    blab,
    chains,
    now,
    advance: (ms: number) => void (t += ms),
    get: (path: string, headers: Record<string, string> = {}) => request('GET', path, undefined, headers),
    post: (path: string, body: unknown = {}, headers: Record<string, string> = {}) => request('POST', path, body, headers),
    check: (body: unknown, o2: { key?: string; idem?: string; headers?: Record<string, string> } = {}) =>
      request('POST', '/v1/authority/check', body, {
        authorization: `Bearer ${o2.key ?? AGENT_KEY}`,
        'idempotency-key': o2.idem ?? `test:${++keyN}`,
        ...o2.headers,
      }),
    paymentHeader,
    x402Fetch,
    /** check that pays the 402: locks the priced bond on the fake chain and retries with the proof (same key). */
    async checkPaying(body: unknown, o2: { key?: string; idem?: string } = {}) {
      const idem = o2.idem ?? `test:${++keyN}`;
      const first = await request('POST', '/v1/authority/check', body, { authorization: `Bearer ${o2.key ?? AGENT_KEY}`, 'idempotency-key': idem });
      if (first.status !== 402) return first;
      const accepted = first.json.accepts[0];
      const utxo = cardano.lockBond(accepted.extra);
      return request('POST', '/v1/authority/check', body, {
        authorization: `Bearer ${o2.key ?? AGENT_KEY}`,
        'idempotency-key': idem,
        'payment-signature': paymentHeader(accepted, accepted.extra, utxo),
      });
    },
    bondLockMs: BOND_LOCK_MS,
    /** A stage run the agent has claimed (status active). */
    async agentRun(): Promise<string> {
      const started = await api.post('/v1/runs', { mandate_id: 'M-001' });
      if (started.status !== 200) throw new Error(`run: ${started.status} ${JSON.stringify(started.json)}`);
      const claimed = await api.post('/v1/agent/runs/claim', {}, { authorization: `Bearer ${AGENT_KEY}` });
      return claimed.json.run_id as string;
    },
    log: async (runId: string) => (await api.get(`/v1/runs/${runId}/log`)).json.events as Array<{ seq: number; type: string; action_id: string | null; payload: any; hash: string; prev_hash: string; created_at: string; run_id: string }>,
    close: async () => {
      await executor.idle();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
  return api;
}
export type Api = Awaited<ReturnType<typeof startApi>>;

// ---- Proposals the agent runtime would sign ------------------------------------------------------
export interface Spec {
  id: string;
  invoice?: Invoice | null;
  amount?: string;
  recipient?: string;
  counterparty?: [string, string];
  type?: ActionIR['type'];
  purpose?: string;
  number?: string;
  rationale?: string;
  mandateId?: string;
}

export function action(s: Spec, nowMs = NOW): ActionIR {
  const inv = s.invoice ?? null;
  return {
    schema: 'action-ir/v0.1',
    id: s.id,
    mandate_id: s.mandateId ?? 'M-001',
    actor: 'cfo-agent-01',
    type: s.type ?? 'pay_invoice',
    purpose: s.purpose ?? 'invoice_payment',
    counterparty: { id: s.counterparty?.[0] ?? 'aws', display: s.counterparty?.[1] ?? 'AWS (demo vendor)' },
    amount: { value: s.amount ?? inv?.amount ?? usdm('1'), asset: 'USDM' },
    recipient: { chain: 'cardano', address: s.recipient ?? inv?.payout ?? ADDR.aws },
    source: { vault: 'acme-treasury' },
    ...(inv ? { reference: { invoice_id: inv.id, invoice_number: s.number ?? inv.number } } : {}),
    rationale: s.rationale ?? 'Invoice is open and matches an approved expense.',
    created_at: new Date(nowMs - 5_000).toISOString(),
  };
}

export function signed(a: ActionIR, sk: Uint8Array = AGENT_SK) {
  return { action: a, agent_signature: signProposal(canonicalHash(a), sk) };
}

export const inv = (number: string) => STAGE_INVOICES.find((i) => i.number === number)!;
