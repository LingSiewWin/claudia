import { type ActionIR, canonicalHash } from '@authority/core';
import { type PublicClient, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { toStoredFields } from '../src/codec';
import { verificationRequestFor, verifyInvoice } from '../src/trigger';
import { FIXTURE, fakeChain, REGISTRY } from './fixtures';

const action = {
  schema: 'action-ir/v0.1',
  id: 'A-0001',
  mandate_id: 'M-001',
  actor: 'cfo-agent-01',
  type: 'pay_invoice',
  purpose: 'invoice_payment',
  counterparty: { id: 'aws', display: 'AWS (demo vendor)' },
  amount: { value: '8420000', asset: 'USDM' },
  recipient: {
    chain: 'cardano',
    address: 'addr_test1qpe3z9srjllzq27zndk5nxlcrxs8u6tr3lvs00xk3pcauwend7e3wv3tk360w5k3uz2nkneydscpuwp9t2uwggpsfzgsgehreu',
  },
  source: { vault: 'acme-treasury' },
  reference: { invoice_id: 'in_1QxDemoAws0001', invoice_number: 'INV-3821' },
  rationale: 'Invoice INV-3821 is open.',
  created_at: '2026-10-07T03:41:02Z',
} satisfies ActionIR;

// Any chain access in these tests is a bug: the outcome must be decided before reading.
const noChain = new Proxy({} as PublicClient, {
  get: () => {
    throw new Error('chain must not be read');
  },
});
const deps = (trigger: () => Promise<string>) => ({
  trigger,
  client: noChain,
  registry: '0x0000000000000000000000000000000000000001' as const,
});

describe('verificationRequestFor', () => {
  it('takes invoice facts from the action and the customer from config', () => {
    expect(verificationRequestFor(action, 'cus_AcmeDemo0001')).toEqual({
      action_hash: canonicalHash(action),
      invoice_id: 'in_1QxDemoAws0001',
      customer_id: 'cus_AcmeDemo0001',
      requested_amount: '8420000',
      requested_currency: 'usd',
      requested_recipient: action.recipient.address,
    });
  });

  it('refuses an action without an invoice reference', () => {
    const { reference: _r, ...noRef } = action;
    expect(() => verificationRequestFor(noRef, 'cus_AcmeDemo0001')).toThrow('action has no invoice reference');
  });
});

describe('verifyInvoice: unavailable dependencies', () => {
  const req = verificationRequestFor(action, 'cus_AcmeDemo0001');

  it('reports unavailable when the simulator fails', async () => {
    const out = await verifyInvoice(req, deps(() => Promise.reject(new Error('cre exited with code 1'))));
    expect(out).toEqual({ status: 'unavailable', error: 'cre exited with code 1' });
  });

  it('reports unavailable when the workflow wrote nothing', async () => {
    const out = await verifyInvoice(req, deps(() => Promise.resolve('Workflow Simulation Result: error')));
    expect(out).toEqual({ status: 'unavailable', error: 'workflow output has no InvoiceVerified tx' });
  });

  it('reports unavailable when Sepolia cannot be read', async () => {
    const rpcDown = {
      waitForTransactionReceipt: () => Promise.reject(new Error('fetch failed')),
    } as unknown as PublicClient;
    const out = await verifyInvoice(req, {
      ...deps(() => Promise.resolve(`[USER LOG] InvoiceVerified tx=0x${'ab'.repeat(32)} report_hash=x`)),
      client: rpcDown,
    });
    expect(out).toEqual({ status: 'unavailable', error: 'fetch failed' });
  });

  it('sends a fresh trigger id per call', async () => {
    const seen: string[] = [];
    const record = (p: { trigger_id: string }) => {
      seen.push(p.trigger_id);
      return Promise.resolve('');
    };
    await verifyInvoice(req, { ...deps(() => Promise.resolve('')), trigger: record });
    await verifyInvoice(req, { ...deps(() => Promise.resolve('')), trigger: record });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('verifyInvoice: trusts only the on-chain report for the trigger it sent', () => {
  const req = verificationRequestFor(action, 'cus_AcmeDemo0001');
  const report = { ...FIXTURE, action_hash: req.action_hash };
  const tx = `0x${'ab'.repeat(32)}` as const;
  const run = (chain: ReturnType<typeof fakeChain>, triggerId: string) =>
    verifyInvoice(req, {
      trigger: () => Promise.resolve(`[USER LOG] InvoiceVerified tx=${tx} report_hash=x`),
      client: chain.client,
      registry: REGISTRY,
      newTriggerId: () => triggerId,
    });

  it('reports the stored report when it answers the trigger the engine sent', async () => {
    const out = await run(fakeChain(report), FIXTURE.trigger_id);
    expect(out).toEqual({
      status: 'reported',
      verified: { report, report_hash: canonicalHash(report), block_time_ms: 1_800_000_000_000 },
      tx_hash: tx,
    });
  });

  it('reports unavailable for a stored report answering another trigger', async () => {
    const out = await run(fakeChain(report), '0b7d6f0e-1c2a-4e5b-8f9a-3d4c5b6a7980');
    expect(out).toEqual({ status: 'unavailable', error: 'report is for another trigger' });
  });

  it('reports unavailable, never a partial report, when stored fields were tampered', async () => {
    const fields = { ...toStoredFields(report), verifiedRecipient: stringToHex('addr_test1attacker') };
    const out = await run(fakeChain(report, { fields }), FIXTURE.trigger_id);
    expect(out).toEqual({ status: 'unavailable', error: 'report hash mismatch' });
  });
});
