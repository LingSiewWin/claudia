import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AuthorizationFields, authorizationDigest, bytesToHex, encodeAuthorization, publicKeyFromSecret, signBytes } from '@authority/core';
import type { MpsClient, Payment, PaymentRequest, SellerSource } from '@authority/masumi';

export const SOURCE: SellerSource = {
  agentIdentifier: `${'a'.repeat(56)}617574686f72697479`,
  supportedPaymentSourceIndex: 0,
  smartContractAddress: 'addr_test1wzexamplecontract',
  policyId: 'a'.repeat(56),
  sellerVkey: 'b'.repeat(56),
  sellerAddress: 'addr_test1qexampleseller',
};

export const WEB = 'https://authority.example';
const confirmed = (newOnChainState: string, txHash: string) => ({ txHash, status: 'Confirmed', newOnChainState, confirmations: 1 });

// In-memory payment service that behaves like the real one for the calls the worker makes.
export function fakeMps() {
  const payments = new Map<string, Payment>();
  const calls = { create: 0, resolve: 0, submit: 0 };
  const client: MpsClient = {
    async createPayment(body: PaymentRequest) {
      calls.create += 1;
      const p: Payment = {
        blockchainIdentifier: `bid-${calls.create}-${body.identifierFromPurchaser}`,
        agentIdentifier: body.agentIdentifier,
        inputHash: body.inputHash,
        payByTime: String(Date.parse(body.payByTime)),
        submitResultTime: String(Date.parse(body.submitResultTime)),
        unlockTime: String(Date.parse(body.unlockTime)),
        externalDisputeUnlockTime: String(Date.parse(body.externalDisputeUnlockTime)),
        sellerReturnAddress: null,
        forceLayer: null,
        onChainState: null,
        resultHash: null,
        NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null },
        CurrentTransaction: null,
        TransactionHistory: [],
        RequestedFunds: body.RequestedFunds.map((f) => ({ ...f })),
        PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2', smartContractAddress: SOURCE.smartContractAddress, policyId: SOURCE.policyId },
        SmartContractWallet: { walletVkey: SOURCE.sellerVkey, walletAddress: SOURCE.sellerAddress },
      };
      payments.set(p.blockchainIdentifier, p);
      return structuredClone(p);
    },
    async resolvePayment(bid) {
      calls.resolve += 1;
      const p = payments.get(bid);
      if (!p) throw new Error(`unknown payment ${bid}`);
      return structuredClone(p);
    },
    async submitResult(bid, hash) {
      calls.submit += 1;
      const p = payments.get(bid);
      if (!p) throw new Error(`unknown payment ${bid}`);
      p.resultHash = hash;
      p.onChainState = 'ResultSubmitted';
      return structuredClone(p);
    },
  };
  const only = (): Payment => {
    const [p] = [...payments.values()];
    if (!p) throw new Error('no payment yet');
    return p;
  };
  return {
    client,
    calls,
    payments,
    only,
    lock(bid = only().blockchainIdentifier) {
      const p = payments.get(bid)!;
      p.onChainState = 'FundsLocked';
      p.CurrentTransaction = confirmed('FundsLocked', 'f0'.repeat(32));
    },
    withdraw(txHash: string, bid = only().blockchainIdentifier) {
      const p = payments.get(bid)!;
      p.onChainState = 'Withdrawn';
      p.CurrentTransaction = confirmed('Withdrawn', txHash);
    },
  };
}

// Test-only engine keys; the worker pins ENGINE_PUBLIC_KEY in these tests.
export const ENGINE_SECRET_KEY = new Uint8Array(32).fill(1);
export const ENGINE_PUBLIC_KEY = bytesToHex(publicKeyFromSecret(ENGINE_SECRET_KEY));
export const OTHER_ENGINE_SECRET_KEY = new Uint8Array(32).fill(9);

// A record signed exactly like the engine signs one, bound to authorityResponse()'s evaluation hashes.
export function authorizationRecord(requiresPrincipal: boolean, o: Partial<AuthorizationFields> = {}, secretKey = ENGINE_SECRET_KEY) {
  const f: AuthorizationFields = {
    chainTag: 0,
    vaultHash: 'aa'.repeat(28),
    mandateRef: 'bb'.repeat(28),
    mandateHash: 'cc'.repeat(32),
    mandateVersion: 3,
    actionHash: 'dd'.repeat(32),
    actionType: 1,
    assetPolicy: '9e'.repeat(28),
    assetName: '745553444d',
    amount: 8_420_000n,
    recipient: 'addr_test1vzs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggfw5wvl',
    nonce: 7n,
    validUntil: 1_800_000_000_000n,
    requiresPrincipal,
    verificationRef: 'ee'.repeat(32),
    ...o,
  };
  const digest = authorizationDigest(f);
  return {
    schema: 'authorization/v0.1' as const,
    message_hex: bytesToHex(encodeAuthorization(f)),
    digest_hex: bytesToHex(digest),
    signature_hex: bytesToHex(signBytes(digest, secretKey)),
    engine_public_key: bytesToHex(publicKeyFromSecret(secretKey)),
    fields: {
      chain_tag: f.chainTag,
      vault_hash: f.vaultHash,
      mandate_ref: f.mandateRef,
      mandate_hash: f.mandateHash,
      mandate_version: f.mandateVersion,
      action_hash: f.actionHash,
      action_type: f.actionType,
      asset_policy: f.assetPolicy,
      asset_name: f.assetName,
      amount: f.amount.toString(),
      recipient: f.recipient,
      nonce: f.nonce.toString(),
      valid_until: Number(f.validUntil),
      requires_principal: f.requiresPrincipal,
      verification_ref: f.verificationRef,
    },
  };
}

export function authorityResponse(
  o: { outcome?: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'; signed?: boolean; authorization?: unknown; interpreted?: unknown; receiptId?: string } = {},
) {
  const signed = o.signed ?? true;
  const outcome = o.outcome ?? 'ALLOW';
  return {
    evaluation: {
      outcome,
      reason: outcome === 'DENY' ? 'RECIPIENT_MISMATCH' : null,
      approvals_required: [],
      checks: [{ id: 'purpose', kind: 'purpose_in', result: 'pass', reason: null, detail: {} }],
      signed,
      action_hash: 'dd'.repeat(32),
      mandate_hash: 'cc'.repeat(32),
      mandate_version: 3,
      verification_hash: 'ee'.repeat(32),
      evaluated_at_ms: 1,
    },
    ...(o.interpreted === undefined ? {} : { interpreted_action: o.interpreted }),
    verification: { report_hash: 'ee'.repeat(32), sepolia_tx: `0x${'ab'.repeat(32)}`, facts: { recipient_match: outcome !== 'DENY' } },
    authorization:
      o.authorization !== undefined ? o.authorization : signed && outcome !== 'DENY' ? authorizationRecord(outcome === 'REQUIRE_APPROVAL') : null,
    receipt_id: o.receiptId ?? 'R-0001',
    receipt_hash: '11'.repeat(32),
    events_url: 'https://api.authority.example/v1/runs/r1/events',
  };
}

type Respond = (body: Record<string, unknown>, n: number) => { status: number; json: unknown; headers?: Record<string, string> };

const transientStatus = (status: number) => status === 408 || status === 429 || status >= 500;

// Local fake of POST /v1/authority/check. It honors Idempotency-Key the way the real API must:
// a repeated key returns the stored response and does not evaluate again. Transient replies are not stored.
export async function startFakeAuthority(respond?: Respond) {
  const calls: { key: string | null; auth: string | null; body: Record<string, unknown> }[] = [];
  const stored = new Map<string, { status: number; json: unknown; headers?: Record<string, string> }>();
  let evaluations = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/authority/check') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const key = (req.headers['idempotency-key'] as string | undefined) ?? null;
      calls.push({ key, auth: req.headers.authorization ?? null, body });
      let out = key === null ? undefined : stored.get(key);
      if (!out) {
        evaluations += 1;
        const signed = typeof (body.proposal as { agent_signature?: unknown } | undefined)?.agent_signature === 'string';
        out = respond
          ? respond(body, evaluations)
          : { status: 200, json: authorityResponse({ signed, receiptId: `R-${evaluations}`, ...(body.request_text ? { interpreted: { note: 'interpreted' } } : {}) }) };
        if (key !== null && !transientStatus(out.status)) stored.set(key, out);
      }
      res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers }).end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    evaluations: () => evaluations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const SIGNED_INPUT = {
  mandate_id: 'M-001',
  proposal: { action: { schema: 'action-ir/v0.1', id: 'A-M-0001', amount: { value: '8420000', asset: 'USDM' } }, agent_signature: 'ab'.repeat(64) },
};
