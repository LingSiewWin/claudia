import { setTimeout as sleep } from 'node:timers/promises';
import { httpAuthority, type RuntimeDeps, runClaimed } from '@authority/agent';
import { clerk } from '@authority/agent/testing';
import { bytesToHex, utf8ToBytes } from '@authority/core';
import { type AgentModel, createInterpreter, type InvoiceFacts } from '@authority/llm';
import { say, scriptedModel, useTool } from '@authority/llm/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declineMessage } from '../src/approvals';
import { ADDR, AGENT_KEY, AGENT_SK, type Api, cfoWallet, LAB_AGENT_SK, MASUMI_KEY, NOW, startApi, usdm } from './harness';
import { WITNESS } from './stage';

// The real agent runtime against the real API in process: same HTTP routes, same engine, CRE and Cardano fakes.
// The model is the deterministic clerk; the CFO is a loop answering pending approvals.

let api: Api;
beforeEach(async () => {
  api = await startApi();
  api.invoices.set('in_l0006', { id: 'in_l0006', number: 'INV-L-0006', amount: usdm('0.50'), payout: ADDR.aws, status: 'open' });
});
afterEach(() => api.close());

const facts = (): InvoiceFacts[] =>
  [...api.invoices.values()]
    .filter((i) => i.status === 'open')
    .map((i) => ({
      id: i.id,
      number: i.number,
      status: 'open',
      vendor_id: i.payout === ADDR.globex ? 'globex' : 'aws',
      vendor_name: i.payout === ADDR.globex ? 'Globex (demo vendor)' : 'AWS (demo vendor)',
      amount_usdm: i.amount,
      currency: 'usd',
      due_date: null,
      memo: null,
      payout_chain: 'cardano-preprod',
      payout_address: i.payout,
    }));

const agent = (model: AgentModel): RuntimeDeps => ({
  authority: httpAuthority({ url: api.url, key: AGENT_KEY }),
  model,
  invoices: { listOpen: async () => facts() },
  agentKeys: new Map([
    ['M-001', AGENT_SK],
    ['M-LAB', LAB_AGENT_SK],
  ]),
  now: api.now,
  sleep: (ms) => sleep(Math.min(ms, 20)),
  pollMs: 10,
  resolveTimeoutMs: 60_000,
  maxTurns: 8,
  log: () => undefined,
});

/** Answers pending approvals by invoice number until stopped, as the CFO console does. */
async function cfo(choices: Record<string, 'approve' | 'decline'>, stop: { done: boolean }) {
  const handled = new Set<string>();
  while (!stop.done) {
    const pending = (await api.get('/v1/approvals?status=pending')).json.approvals as Array<{ approval_id: string; action: { reference?: { invoice_number: string } } }>;
    for (const p of pending) {
      const choice = choices[p.action.reference?.invoice_number ?? ''];
      if (!choice || handled.has(p.approval_id)) continue;
      handled.add(p.approval_id);
      if (choice === 'approve') {
        const approved = await api.post(`/v1/approvals/${p.approval_id}/approve`, {});
        await api.post('/v1/executions', { approval_id: p.approval_id, authorization_digest: approved.json.authorization.digest_hex, cfo_witness_cbor: WITNESS });
      } else {
        const { wallet, address } = await cfoWallet();
        await api.post(`/v1/approvals/${p.approval_id}/decline`, await wallet.signData(bytesToHex(utf8ToBytes(declineMessage(p.approval_id))), address));
      }
    }
    await sleep(10);
  }
}

describe('agent runtime against the API', () => {
  it('works a stage run end to end: seven outcomes, two settlements, final vault 108.58', async () => {
    const { run_id } = (await api.post('/v1/runs', { mandate_id: 'M-001' })).json;
    const d = agent(clerk({ gullible: true }));
    const claim = await d.authority.claim();
    expect(claim).toMatchObject({ run_id, kind: 'stage', mandate_id: 'M-001' });
    const stop = { done: false };
    const answering = cfo({ 'INV-3822': 'approve', 'INV-G-0042': 'decline' }, stop);
    const result = await runClaimed(d, claim!);
    stop.done = true;
    await answering;
    await api.executor.idle();
    expect(result.items.map((i) => [i.proposal?.outcome, i.proposal?.reason, i.proposal?.resolution])).toEqual([
      ['ALLOW', null, 'settled'],
      ['REQUIRE_APPROVAL', null, 'settled'],
      ['REQUIRE_APPROVAL', 'PRINCIPAL_DECLINED', 'declined'],
      ['DENY', 'AMOUNT_ABOVE_HARD_CAP', 'denied'],
      ['DENY', 'PURPOSE_NOT_AUTHORIZED', 'denied'],
      ['DENY', 'RECIPIENT_MISMATCH', 'denied'],
      ['DENY', 'TREASURY_FLOOR_VIOLATION', 'denied'],
    ]);
    const chain = api.chains.get(api.b001.vaultHash)!;
    expect([chain.balance, chain.spent]).toEqual([108_580_000n, 26_420_000n]);
    const log = await api.log(run_id);
    expect(log.filter((e) => e.type === 'ReceiptProven').map((e) => e.action_id)).toEqual([result.items[0]!.action_id, result.items[1]!.action_id]);
    expect(log.find((e) => e.type === 'ActionDenied' && e.action_id === result.items[5]!.action_id)?.payload).toEqual({ reason: 'RECIPIENT_MISMATCH', layer: 'cre' });
  }, 60_000);

  it('prompt injection, model fooled: CRE stops it and the lab records stopped_by cre', async () => {
    const { run_id } = (await api.post('/v1/lab/attacks', { attack: 'prompt_injection' })).json;
    const d = agent(clerk({ gullible: true }));
    const result = await runClaimed(d, (await d.authority.claim())!);
    expect(result.items[0]!.proposal).toMatchObject({ invoice_number: 'INV-L-0006', outcome: 'DENY', reason: 'RECIPIENT_MISMATCH' });
    const attack = (await api.log(run_id)).filter((e) => e.type === 'AttackResult').map((e) => e.payload);
    expect(attack).toEqual([{ attack: 'prompt_injection', stopped_by: 'cre', code: 'RECIPIENT_MISMATCH', funds_moved: '0', tx_hash: null }]);
  });

  it('prompt injection, model not fooled: recorded as AGENT_REJECTED_PHISHING, never faked', async () => {
    const { run_id } = (await api.post('/v1/lab/attacks', { attack: 'prompt_injection' })).json;
    const d = agent(clerk({ gullible: false }));
    const result = await runClaimed(d, (await d.authority.claim())!);
    expect(result.items[0]!.proposal).toMatchObject({ recipient: ADDR.aws, outcome: 'ALLOW', resolution: 'authorized' });
    const attack = (await api.log(run_id)).filter((e) => e.type === 'AttackResult').map((e) => e.payload);
    expect(attack).toEqual([{ attack: 'prompt_injection', stopped_by: 'agent', code: 'AGENT_REJECTED_PHISHING', funds_moved: '0', tx_hash: null }]);
  });

  it('the direct variant needs no model and is always stopped by CRE', async () => {
    const { run_id } = (await api.post('/v1/lab/attacks', { attack: 'prompt_injection_direct' })).json;
    const model = clerk({ gullible: false });
    const d = agent(model);
    await runClaimed(d, (await d.authority.claim())!);
    expect(model.inputs).toHaveLength(0);
    const attack = (await api.log(run_id)).filter((e) => e.type === 'AttackResult').map((e) => e.payload);
    expect(attack).toEqual([{ attack: 'prompt_injection_direct', stopped_by: 'cre', code: 'RECIPIENT_MISMATCH', funds_moved: '0', tx_hash: null }]);
  });

  it('work and decision history are served to the agent key only', async () => {
    const { run_id } = (await api.post('/v1/runs', { mandate_id: 'M-001' })).json;
    const auth = { authorization: `Bearer ${AGENT_KEY}` };
    expect((await fetch(`${api.url}/v1/agent/runs/${run_id}/work`)).status).toBe(401);
    expect((await fetch(`${api.url}/v1/agent/runs/${run_id}/work`, { headers: { authorization: `Bearer ${MASUMI_KEY}` } })).status).toBe(401);
    const work = (await (await fetch(`${api.url}/v1/agent/runs/${run_id}/work`, { headers: auth })).json()) as { queue: unknown[]; messages: unknown[] };
    expect([work.queue.length, work.messages.length]).toEqual([7, 3]);
    expect((await fetch(`${api.url}/v1/agent/decisions?mandate_id=M-001`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${api.url}/v1/agent/decisions`, { headers: auth })).status).toBe(400);
  });
});

describe('plain-English interpreter in the API', () => {
  it('turns request_text into an unsigned action that is evaluated and never authorized', async () => {
    await api.close();
    const model = scriptedModel((input, call) => {
      if (call === 0) return useTool('find_invoice', { invoice_number: 'INV-3821' });
      if (call === 1) {
        const inv = facts().find((i) => i.number === 'INV-3821')!;
        return useTool('submit_action', {
          type: 'pay_invoice',
          purpose: 'invoice_payment',
          counterparty_id: 'aws',
          counterparty_display: 'AWS (demo vendor)',
          amount: '8.42',
          recipient_address: inv.payout_address,
          invoice: { invoice_id: inv.id, invoice_number: 'INV-3821' },
          rationale: 'Requested in plain English.',
        });
      }
      return say(String(input.messages.length));
    });
    api = await startApi({ interpret: createInterpreter({ model, findInvoice: async (n) => facts().find((i) => i.number === n) ?? null, now: () => NOW }) });
    const res = await api.check({ mandate_id: 'M-001', request_text: 'Pay AWS invoice INV-3821', execute: false }, { key: MASUMI_KEY });
    expect(res.status).toBe(200);
    expect(res.json.interpreted_action).toMatchObject({ mandate_id: 'M-001', amount: { value: '8420000', asset: 'USDM' }, reference: { invoice_number: 'INV-3821' } });
    expect(res.json.evaluation.signed).toBe(false);
    expect(res.json.authorization).toBeNull();
  });
});
