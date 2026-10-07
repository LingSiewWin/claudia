import { bytesToHex, utf8ToBytes } from '@authority/core';
import { MeshWallet } from '@meshsdk/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declineMessage } from '../src/approvals';
import { ADDR, action, AGENT_KEY, type Api, cfoWallet, inv, signed, startApi, usdm } from './harness';

let api: Api;
let run: string;
beforeEach(async () => {
  api = await startApi();
  run = await api.agentRun();
});
afterEach(() => api.close());

const WITNESS = 'a10081825820' + 'cd'.repeat(32) + '5840' + 'ef'.repeat(64);
const GLOBEX = { id: 'A-3', invoice: inv('INV-G-0042'), counterparty: ['globex', 'Globex (demo vendor)'] as [string, string] };
const requestApproval = async (spec: Parameters<typeof action>[0] = { id: 'A-2', invoice: inv('INV-3822') }) => {
  const res = await api.checkPaying({ mandate_id: 'M-001', proposal: signed(action(spec)), execute: true, run_id: run });
  expect(res.json.evaluation.outcome).toBe('ESCALATE');
  return res.json.approval_id as string;
};
const declineSig = async (approvalId: string, wallet?: MeshWallet, reason: 'legitimate' | 'frivolous' = 'legitimate') => {
  const w = wallet ?? (await cfoWallet()).wallet;
  return { ...(await w.signData(bytesToHex(utf8ToBytes(declineMessage(approvalId, reason))), await w.getChangeAddress())), reason };
};

describe('approve once', () => {
  it('re-verifies, re-evaluates, signs with requires_principal and builds the tx the CFO co-signs', async () => {
    const id = await requestApproval();
    const pending = (await api.get('/v1/approvals?status=pending')).json.approvals;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ approval_id: id, run_id: run, action: { id: 'A-2' } });
    const res = await api.post(`/v1/approvals/${id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.json.authorization.fields.requires_principal).toBe(true);
    expect(res.json.unsigned_tx_cbor).toMatch(/^84a4/);
    expect(api.cre.calls).toHaveLength(2); // a fresh verification at approval time
    expect(api.cardano.built.at(-1)!.cfo).toBe((await cfoWallet()).pkh);
    expect(res.json.bond_tx.unsigned_tx_cbor).toMatch(/^84a4/);
    expect((await api.log(run)).slice(-9).map((e) => e.type)).toEqual([
      'CFOApproved',
      'AuthorityEvaluationStarted',
      'AuthorityEvaluated',
      'CREVerificationStarted',
      'CREVerificationCompleted',
      'AuthorityEvaluationStarted',
      'AuthorityEvaluated',
      'AuthorizationIssued',
      'TransactionBuilt',
    ]);
    // same click again: the same authorization and tx, no new nonce, no new CRE run
    const again = await api.post(`/v1/approvals/${id}/approve`, {});
    expect(again.json.authorization.digest_hex).toBe(res.json.authorization.digest_hex);
    expect(api.cre.calls).toHaveLength(2);

    const exec = await api.post('/v1/executions', { approval_id: id, authorization_digest: res.json.authorization.digest_hex, cfo_witness_cbor: WITNESS });
    expect(exec.json).toEqual({ run_id: run, tx_hash: res.json.tx_hash });
    await api.executor.idle();
    const events = await api.log(run);
    expect(events.at(-1)).toMatchObject({ type: 'ReceiptProven' });
    const receipt = (await api.get(`/v1/receipts/${events.at(-1)!.payload.receipt_id}`)).json.receipt;
    expect(receipt.approval).toMatchObject({ required: true, cfo_key_hash: (await cfoWallet()).pkh, bond: { status: 'locked' } });
    expect(receipt.approval.brief_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(api.chains.get(api.b001.vaultHash)!.balance).toBe(BigInt(usdm('117')));
  });

  it('state changed since the request (vault now below floor + amount): DENY, approval closed, nothing signed', async () => {
    const id = await requestApproval();
    api.chains.get(api.b001.vaultHash)!.balance = BigInt(usdm('110'));
    const res = await api.post(`/v1/approvals/${id}/approve`, {});
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/TREASURY_FLOOR_VIOLATION/);
    expect((await api.log(run)).map((e) => e.type)).not.toContain('AuthorizationIssued');
    expect((await api.post(`/v1/approvals/${id}/approve`, {})).status).toBe(409);
  });

  it('a stored proposal edited in our database (recipient swapped) fails the agent signature on re-evaluation', async () => {
    const id = await requestApproval();
    const [row] = await api.db.query<{ proposal: string }>('select proposal from approvals');
    const p = JSON.parse(row!.proposal);
    p.action.recipient.address = ADDR.attacker;
    await api.db.query('update approvals set proposal = $1', [JSON.stringify(p)]);
    const res = await api.post(`/v1/approvals/${id}/approve`, {});
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/INVALID_AGENT_SIGNATURE/);
  });

  it('a stored evaluation edited to ALLOW changes nothing: the authorization still requires the principal', async () => {
    const id = await requestApproval();
    const [row] = await api.db.query<{ evaluation: string }>('select evaluation from approvals');
    await api.db.query('update approvals set evaluation = $1', [JSON.stringify({ ...JSON.parse(row!.evaluation), outcome: 'ALLOW', approvals_required: [] })]);
    const res = await api.post(`/v1/approvals/${id}/approve`, {});
    expect(res.json.authorization.fields.requires_principal).toBe(true);
  });

  it('CRE down at approval time: 503, the approval stays pending', async () => {
    const id = await requestApproval();
    api.cre.setUnavailable('rpc down');
    expect((await api.post(`/v1/approvals/${id}/approve`, {})).status).toBe(503);
    expect((await api.get('/v1/approvals?status=pending')).json.approvals).toHaveLength(1);
  });

  it('executions need the matching digest of an approved authorization', async () => {
    const id = await requestApproval();
    expect((await api.post('/v1/executions', { approval_id: id, authorization_digest: 'aa'.repeat(32), cfo_witness_cbor: WITNESS })).status).toBe(409);
    const ok = await api.post(`/v1/approvals/${id}/approve`, {});
    expect((await api.post('/v1/executions', { approval_id: id, authorization_digest: 'aa'.repeat(32), cfo_witness_cbor: WITNESS })).status).toBe(409);
    expect((await api.post('/v1/executions', { approval_id: id, authorization_digest: ok.json.authorization.digest_hex, cfo_witness_cbor: WITNESS })).status).toBe(200);
    expect((await api.post('/v1/executions', { approval_id: id, authorization_digest: ok.json.authorization.digest_hex, cfo_witness_cbor: WITNESS })).status).toBe(409);
  });
});

describe('decline needs the principal (CIP-8 over declineMessage)', () => {
  it('declineMessage is the RFC 8785 text the web console signs', () => {
    expect(declineMessage('AP-7', 'legitimate')).toBe('{"approval_id":"AP-7","decision":"decline","reason":"legitimate"}');
  });

  it('the CFO signature declines: CFODeclined, PRINCIPAL_DECLINED, no longer pending', async () => {
    const id = await requestApproval(GLOBEX);
    const res = await api.post(`/v1/approvals/${id}/decline`, await declineSig(id));
    expect(res.json).toMatchObject({ ok: true, reason: 'legitimate', bond_tx: { tx_hash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect((await api.log(run)).at(-1)).toMatchObject({ type: 'CFODeclined', action_id: 'A-3', payload: { approval_id: id, reason: 'legitimate' } });
    expect((await api.get('/v1/approvals?status=pending')).json.approvals).toEqual([]);
    expect((await api.post(`/v1/approvals/${id}/approve`, {})).status).toBe(409);
  });

  it('401 without a signature, with another approval\'s signature, or with another key', async () => {
    const id = await requestApproval();
    const other = await requestApproval(GLOBEX);
    expect((await api.post(`/v1/approvals/${id}/decline`, {})).status).toBe(401);
    expect((await api.post(`/v1/approvals/${id}/decline`, await declineSig(other))).status).toBe(401);
    const stranger = new MeshWallet({ networkId: 0, key: { type: 'cli', payment: `5820${'09'.repeat(32)}` } });
    await stranger.init();
    expect((await api.post(`/v1/approvals/${id}/decline`, await declineSig(id, stranger))).status).toBe(401);
    expect((await api.get('/v1/approvals?status=pending')).json.approvals).toHaveLength(2);
  });

  it('the principal key hash comes from the anchor, not from our database', async () => {
    const id = await requestApproval();
    const stranger = new MeshWallet({ networkId: 0, key: { type: 'cli', payment: `5820${'09'.repeat(32)}` } });
    await stranger.init();
    const { deserializeAddress } = await import('@meshsdk/core');
    const strangerPkh = deserializeAddress(await stranger.getChangeAddress()).pubKeyHash;
    const [row] = await api.db.query<{ doc: string }>(`select doc from mandates where id = 'M-001'`);
    await api.db.query(`update mandates set doc = $1 where id = 'M-001'`, [row!.doc.replace((await cfoWallet()).pkh, strangerPkh)]);
    expect((await api.post(`/v1/approvals/${id}/decline`, await declineSig(id, stranger))).status).toBe(401);
  });

  it('an unknown approval is 404 and agent auth is not needed to read the inbox', async () => {
    expect((await api.post('/v1/approvals/AP-999/approve', {})).status).toBe(404);
    expect((await api.get('/v1/approvals?status=pending')).status).toBe(200);
    expect(AGENT_KEY).toBeTruthy();
  });
});
