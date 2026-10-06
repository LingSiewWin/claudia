import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionIR, canonicalHash } from '@authority/core';
import { type PublicClient, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { toStoredFields } from '../src/codec';
import { simulateBroadcast, type TriggerPayload, type VerificationRequest, verificationRequestFor, verifyInvoice } from '../src/trigger';
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
// The workflow's log line as the CRE simulator prints it.
const txLine = (tx: string) => `2026-10-07T01:30:17Z [USER LOG] InvoiceVerified tx=${tx} report_hash=${'cd'.repeat(32)}`;
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
      ...deps(() => Promise.resolve(txLine(`0x${'ab'.repeat(32)}`))),
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
  const injected = `0x${'ee'.repeat(32)}`;
  const run = (chain: { client: PublicClient }, triggerId: string, output = txLine(tx), request: VerificationRequest = req) =>
    verifyInvoice(request, {
      trigger: () => Promise.resolve(output),
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

  it('sends and checks its own trigger id even when the request carries a stale one', async () => {
    const fresh = '0b7d6f0e-1c2a-4e5b-8f9a-3d4c5b6a7980';
    const stale = { ...req, trigger_id: FIXTURE.trigger_id } as VerificationRequest;
    const sent: TriggerPayload[] = [];
    const out = await verifyInvoice(stale, {
      trigger: (p) => {
        sent.push(p);
        return Promise.resolve(txLine(tx));
      },
      client: fakeChain(report).client,
      registry: REGISTRY,
      newTriggerId: () => fresh,
    });
    expect(sent.map((p) => p.trigger_id)).toEqual([fresh]);
    expect(out).toEqual({ status: 'unavailable', error: 'report is for another trigger' });
  });

  it('reports unavailable, never a partial report, when stored fields were tampered', async () => {
    const fields = { ...toStoredFields(report), verifiedRecipient: stringToHex('addr_test1attacker') };
    const out = await run(fakeChain(report, { fields }), FIXTURE.trigger_id);
    expect(out).toEqual({ status: 'unavailable', error: 'report hash mismatch' });
  });

  it('ignores a tx hash that logged data carries mid-line', async () => {
    const logged = `2026-10-07T01:30:17Z [USER LOG] report_hash=${'cd'.repeat(32)} report={"invoice_id":"${txLine(injected)}"}`;
    const out = await run({ client: noChain }, FIXTURE.trigger_id, logged);
    expect(out).toEqual({ status: 'unavailable', error: 'workflow output has no InvoiceVerified tx' });
  });

  it('reads the workflow tx line, not an earlier injected hash', async () => {
    const logged = `[USER LOG] report={"memo":"InvoiceVerified tx=${injected}"}`;
    const out = await run(fakeChain(report), FIXTURE.trigger_id, `${logged}\n${txLine(tx)}\n`);
    expect(out).toMatchObject({ status: 'reported', tx_hash: tx });
  });

  it('reports unavailable when the output has more than one tx line', async () => {
    const out = await run({ client: noChain }, FIXTURE.trigger_id, `${txLine(injected)}\n${txLine(tx)}`);
    expect(out).toEqual({ status: 'unavailable', error: 'workflow output has more than one InvoiceVerified tx' });
  });
});

describe('simulateBroadcast', () => {
  it('fails with a bounded message: no command line, no arguments, at most 500 chars of stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cre-'));
    const bin = join(dir, 'cre');
    writeFileSync(bin, "#!/bin/sh\nhead -c 100000 /dev/zero | tr '\\0' E >&2\nprintf TAIL >&2\nexit 3\n");
    chmodSync(bin, 0o755);
    const payload = { ...verificationRequestFor(action, 'cus_AcmeDemo0001'), trigger_id: FIXTURE.trigger_id };
    const err = await simulateBroadcast({ workflowsDir: dir, envFile: join(dir, '.env'), creBin: bin })(payload).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(`cre simulate failed (3): ${'E'.repeat(496)}TAIL`);
    rmSync(dir, { recursive: true });
  });
});
