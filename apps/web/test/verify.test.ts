import { canonicalHash, fieldsFromRecord } from '@authority/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { koiosTx, sepoliaReceipt, type KoiosTx } from '../lib/chain';
import type { ReceiptBundle } from '../lib/contract';
import { type Fetchers, SUMMARY, groupStatus, overall, verdict, verifyReceipt } from '../lib/verify';
import { bundle, recorded } from './load';
// Raw signer (not exported by @authority/core): the test forges an authorization with a key that is not on-chain.
import { signAuthorization } from '../../../packages/core/src/authorization';

const fetchers: Fetchers = {
  cardano: async (h) => structuredClone(recorded.koios[h] ?? null),
  sepolia: async (h) => structuredClone(recorded.sepolia[h] ?? null),
  registry: recorded.registry,
};
const run = async (b: ReceiptBundle, fx: Fetchers = fetchers) => {
  const checks = await verifyReceipt(b, fx);
  return { result: overall(checks), failed: checks.filter((c) => c.status === 'fail').map((c) => c.id) };
};

afterEach(() => vi.unstubAllGlobals());

describe('browser Verify (assumes our server is malicious)', () => {
  it.each(['R-0001', 'R-0002'])('%s passes every check on untouched evidence', async (id) => {
    expect(await run(bundle(id))).toEqual({ result: 'pass', failed: [] });
  });

  it('detects an edited amount in the Action IR', async () => {
    const b = bundle();
    b.receipt.action.ir.amount.value = '84200000';
    expect((await run(b)).failed).toEqual(expect.arrayContaining(['receipt_hash', 'action_hash', 'binding']));
  });

  it('detects an edit even when the server recomputes the receipt and action hashes', async () => {
    const b = bundle();
    b.receipt.action.ir.amount.value = '84200000';
    b.receipt.action.hash = canonicalHash(b.receipt.action.ir);
    b.receipt_hash = canonicalHash(b.receipt);
    const r = await run(b);
    expect(r.result).toBe('fail');
    expect(r.failed).toEqual(expect.arrayContaining(['agent_signature', 'binding']));
  });

  it('detects an authorization re-signed with a key that is not on-chain', async () => {
    const b = bundle();
    const forged = signAuthorization({ ...fieldsFromRecord(b.authorization), amount: 84_200_000n }, new Uint8Array(32).fill(9));
    b.authorization = forged;
    b.receipt.authorization.digest = forged.digest_hex;
    b.receipt.authorization.signature = forged.signature_hex;
    b.receipt.authorization.engine_public_key = forged.engine_public_key;
    b.receipt_hash = canonicalHash(b.receipt);
    expect((await run(b)).failed).toEqual(expect.arrayContaining(['binding', 'engine_signature', 'vault_redeemer']));
  });

  it('detects a swapped recipient', async () => {
    const b = bundle();
    b.authorization.fields.recipient = 'addr_test1vrpu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8sclmre6l';
    expect((await run(b)).failed).toEqual(expect.arrayContaining(['binding', 'message_bytes', 'engine_signature', 'payment']));
  });

  it('detects a settlement tx that is not on Cardano', async () => {
    const b = bundle();
    b.receipt.settlement.tx_hash = 'ab'.repeat(32);
    b.receipt_hash = canonicalHash(b.receipt);
    expect((await run(b)).failed).toContain('cardano_tx');
  });

  it('detects a CRE report hash that Sepolia never recorded', async () => {
    const b = bundle();
    const fx: Fetchers = { ...fetchers, registry: `0x${'11'.repeat(20)}` };
    expect((await run(b, fx)).failed).toEqual(['cre_report']);
  });

  it('reports unavailable, not pass, when a chain source is down', async () => {
    const fx: Fetchers = { ...fetchers, cardano: () => Promise.reject(new Error('Koios HTTP 503')) };
    const checks = await verifyReceipt(bundle(), fx);
    expect(overall(checks)).toBe('unavailable');
    expect(checks.find((c) => c.id === 'cardano_tx')?.detail).toBe('Koios HTTP 503');
    expect(SUMMARY.map((g) => groupStatus(checks, g.ids))).toEqual(['unavailable', 'unavailable', 'unavailable', 'pass', 'pass']);
  });

  it('a failing Koios relay yields "Cardano data unavailable", never VERIFIED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Koios unreachable"}', { status: 502 })));
    const checks = await verifyReceipt(bundle(), { ...fetchers, cardano: koiosTx });
    expect(verdict(checks)).toEqual({ result: 'unavailable', text: 'Cardano data unavailable. Verification cannot be completed locally.' });
    expect(JSON.stringify(checks)).not.toMatch(/verified/i);
  });

  it('a failing Sepolia RPC yields Sepolia data unavailable, never VERIFIED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"timeout"}', { status: 503 })));
    const checks = await verifyReceipt(bundle(), { ...fetchers, sepolia: sepoliaReceipt });
    expect(verdict(checks)).toEqual({ result: 'unavailable', text: 'Sepolia data unavailable. Verification cannot be completed locally.' });
    expect(JSON.stringify(checks)).not.toMatch(/verified/i);
  });

  it('treats a throwing chain helper as unavailable, never as a throw', async () => {
    const fx: Fetchers = {
      ...fetchers,
      cardano: async () => ({ tx_hash: 'ab'.repeat(32) }) as KoiosTx,
    };
    const checks = await verifyReceipt(bundle(), fx);
    expect(overall(checks)).toBe('unavailable');
    expect(checks.find((c) => c.id === 'cardano_tx')?.status).toBe('unavailable');
  });
});
