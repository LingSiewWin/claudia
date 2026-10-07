import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EscalationPriceSchema, sha256Hex } from '@authority/core';
import { ASSET_TRANSFER_METHOD_SCRIPT, CARDANO_PREPROD_CAIP2, type CardanoExtraScript, isCardanoNetwork, SCHEME_EXACT } from '@x402/cardano';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBondDatum } from '@authority/cardano';
import { action, ADDR, type Api, inv, signed, startApi } from './harness';

// The 402 also speaks the x402 exact scheme on Cardano (scheme_exact_cardano, assetTransferMethod script): the
// standard decoders read our PAYMENT-REQUIRED, and a standard PAYMENT-SIGNATURE (signed, unbroadcast lock tx plus
// nonce) is submitted by the API and read back as the bond. @x402/core and @x402/cardano are the reference types.

const ESCROW_SCRIPT_HASH = '03fb014855114c2e0def436d15bb36c2ffadefa59da6afabad8a4137';
// A stand-in for the signed lock tx: the fake chain hashes whatever CBOR it is handed.
const TX_HEX = '84a400d90102818258' + 'ab'.repeat(40);
const TX_B64 = Buffer.from(TX_HEX, 'hex').toString('base64');
const NONCE = `${'cd'.repeat(32)}#1`;

let api: Api;
let run: string;
let facilitator: Server | null = null;
afterEach(async () => {
  api.close();
  if (facilitator) await new Promise((r) => facilitator!.close(r));
  facilitator = null;
});

const body = () => ({ mandate_id: 'M-001', proposal: signed(action({ id: 'E-1', invoice: inv('INV-3822') })), execute: true, run_id: run });
const exactEntry = (required: ReturnType<typeof decodePaymentRequiredHeader>): PaymentRequirements => {
  const entry = required.accepts.find((a) => a.scheme === SCHEME_EXACT);
  if (!entry) throw new Error('no exact entry');
  return entry;
};
const payloadFor = (accepted: PaymentRequirements): PaymentPayload => ({
  x402Version: 2,
  resource: { url: 'https://api.test/v1/authority/check' },
  accepted,
  payload: { transaction: TX_B64, nonce: NONCE },
});

describe('x402 exact scheme on Cardano', () => {
  beforeEach(async () => {
    api = await startApi();
    run = await api.agentRun();
  });

  it('PAYMENT-REQUIRED decodes with @x402/core and carries a script-method exact entry for the escrow', async () => {
    const res = await api.check(body());
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get('payment-required')!);
    expect(required.x402Version).toBe(2);
    expect(required.accepts.map((a) => a.scheme)).toEqual(['cardano-escrow', SCHEME_EXACT]);
    const exact = exactEntry(required);
    expect(isCardanoNetwork(exact.network)).toBe(true);
    expect(exact).toMatchObject({ scheme: SCHEME_EXACT, network: CARDANO_PREPROD_CAIP2, amount: '5000000', asset: 'lovelace', maxTimeoutSeconds: 3600 });
    expect(exact.payTo).toBe(api.cardano.port.bondAddresses().escrow);
    const extra = exact.extra as CardanoExtraScript;
    expect(extra.assetTransferMethod).toBe(ASSET_TRANSFER_METHOD_SCRIPT);
    expect(extra.scriptHash).toBe(ESCROW_SCRIPT_HASH);
    expect(extra.confirmationPolicy).toEqual({ l1Confirmations: 0 });
    expect(extra.datum).toBeUndefined();
    // The price a client builds the escalation_bond datum from, identical to the cardano-escrow entry.
    expect(EscalationPriceSchema.parse(extra.escalation)).toEqual(required.accepts[0]!.extra);
  });

  it('a check naming the bond refund address gets the complete inline datum in extra.datum', async () => {
    const res = await api.check({ ...body(), bond_refund_address: ADDR.aws });
    expect(res.status).toBe(402);
    const extra = exactEntry(decodePaymentRequiredHeader(res.headers.get('payment-required')!)).extra as CardanoExtraScript;
    expect(extra.datum).toMatch(/^[0-9a-f]+$/);
    const price = EscalationPriceSchema.parse(extra.escalation);
    expect(parseBondDatum(extra.datum!)).toMatchObject({ approval_ref: sha256Hex(price.approval_id), action_hash: price.action_hash, approver_pkh: price.approver_key_hash, amount: 5_000_000n, locked_until_ms: price.locked_until_ms, agent_stake: null });
    const bad = await api.check({ ...body(), bond_refund_address: api.cardano.port.bondAddresses().escrow });
    expect(bad.status).toBe(400);
  });

  it('a standard PAYMENT-SIGNATURE is submitted by the API, read back as the bond, and answered with PAYMENT-RESPONSE', async () => {
    const first = await api.check(body(), { idem: 'exact' });
    const accepted = exactEntry(decodePaymentRequiredHeader(first.headers.get('payment-required')!));
    const price = EscalationPriceSchema.parse((accepted.extra as CardanoExtraScript).escalation);
    const header = encodePaymentSignatureHeader(payloadFor(accepted));
    expect(decodePaymentSignatureHeader(header).payload).toEqual({ transaction: TX_B64, nonce: NONCE });

    // Nobody has broadcast the lock yet: the API submits it, the escrow UTxO is not visible, the price stands.
    const unseen = await api.check(body(), { idem: 'exact', headers: { 'payment-signature': header } });
    expect(unseen.status).toBe(402);
    expect(api.cardano.submitted).toEqual([TX_HEX]);
    expect(unseen.json.accepts[0].extra).toEqual(price);

    // The lock landed (the fake chain knows the hash of the submitted CBOR): the same header settles.
    const utxo = api.cardano.lockBond(price, { txCbor: TX_HEX });
    expect(utxo.tx_hash).toBe(sha256Hex(`tx:${TX_HEX}`));
    const paid = await api.check(body(), { idem: 'exact', headers: { 'payment-signature': header } });
    expect(paid.status).toBe(200);
    expect(paid.json).toMatchObject({ evaluation: { outcome: 'ESCALATE' }, approval_id: 'AP-1', bond: { status: 'locked', tx_hash: utxo.tx_hash, amount: '5000000' } });
    expect(decodePaymentResponseHeader(paid.headers.get('payment-response')!)).toEqual({ success: true, network: CARDANO_PREPROD_CAIP2, transaction: utxo.tx_hash });
    expect((await api.get('/v1/approvals?status=pending')).json.approvals).toMatchObject([{ approval_id: 'AP-1', bond: { tx_hash: utxo.tx_hash } }]);
    const events = await api.log(run);
    expect(events.at(-2)!.type).toBe('BondLocked');
    expect(events.at(-1)!.type).toBe('ApprovalRequested');
  });

  it('a payload naming another approval or a malformed one is no bond', async () => {
    const first = await api.check(body());
    const accepted = exactEntry(decodePaymentRequiredHeader(first.headers.get('payment-required')!));
    const other = { ...accepted, extra: { ...(accepted.extra as CardanoExtraScript), escalation: { ...(accepted.extra as CardanoExtraScript).escalation as object, approval_id: 'AP-9' } } };
    const r1 = await api.check(body(), { headers: { 'payment-signature': encodePaymentSignatureHeader(payloadFor(other)) } });
    expect(r1.status).toBe(402);
    const r2 = await api.check(body(), { headers: { 'payment-signature': encodePaymentSignatureHeader({ ...payloadFor(accepted), payload: { transaction: TX_B64 } }) } });
    expect(r2.status).toBe(402);
    expect(api.cardano.submitted).toEqual([]);
  });
});

describe('x402 exact scheme through a facilitator', () => {
  const calls: { path: string; body: any }[] = [];
  let verify: Record<string, unknown> = { isValid: true, payer: ADDR.aws };
  beforeEach(async () => {
    calls.length = 0;
    verify = { isValid: true, payer: ADDR.aws };
    facilitator = createServer((req, res) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        const json = JSON.parse(text);
        calls.push({ path: req.url!, body: json });
        const txHex = Buffer.from(json.paymentPayload.payload.transaction, 'base64').toString('hex');
        const reply = req.url === '/verify' ? verify : { success: true, transaction: sha256Hex(`tx:${txHex}`), network: json.paymentRequirements.network, extra: { status: 'confirmed', confirmations: 0 } };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => facilitator!.listen(0, '127.0.0.1', r));
    api = await startApi({ facilitatorUrl: `http://127.0.0.1:${(facilitator.address() as AddressInfo).port}/` });
    run = await api.agentRun();
  });

  it('verify then settle, with our requirements, and nothing submitted locally', async () => {
    const first = await api.check(body(), { idem: 'fac' });
    const accepted = exactEntry(decodePaymentRequiredHeader(first.headers.get('payment-required')!));
    const price = EscalationPriceSchema.parse((accepted.extra as CardanoExtraScript).escalation);
    const utxo = api.cardano.lockBond(price, { txCbor: TX_HEX });
    const paid = await api.check(body(), { idem: 'fac', headers: { 'payment-signature': encodePaymentSignatureHeader(payloadFor(accepted)) } });
    expect(paid.status).toBe(200);
    expect(paid.json.bond).toMatchObject({ status: 'locked', tx_hash: utxo.tx_hash });
    expect(calls.map((c) => c.path)).toEqual(['/verify', '/settle']);
    expect(calls[0]!.body).toMatchObject({ x402Version: 2, paymentRequirements: accepted, paymentPayload: { accepted, payload: { transaction: TX_B64, nonce: NONCE } } });
    expect(api.cardano.submitted).toEqual([]);
  });

  it('a rejected verify is 402 again and never settled', async () => {
    verify = { isValid: false, invalidReason: 'invalid_exact_cardano_payload_nonce_not_on_chain', payer: '' };
    const first = await api.check(body(), { idem: 'rej' });
    const accepted = exactEntry(decodePaymentRequiredHeader(first.headers.get('payment-required')!));
    api.cardano.lockBond(EscalationPriceSchema.parse((accepted.extra as CardanoExtraScript).escalation), { txCbor: TX_HEX });
    const again = await api.check(body(), { idem: 'rej', headers: { 'payment-signature': encodePaymentSignatureHeader(payloadFor(accepted)) } });
    expect(again.status).toBe(402);
    expect(calls.map((c) => c.path)).toEqual(['/verify']);
    expect((await api.get('/v1/approvals?status=pending')).json.approvals).toEqual([]);
  });
});
