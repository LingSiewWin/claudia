import { bytesToHex, utf8ToBytes } from '@authority/core';
import { declineMessage } from '../src/approvals';
import { ADDR, AGENT_KEY, action, type Api, cfoWallet, inv, type Spec, signed, usdm } from './harness';

export const WITNESS = `a10081825820${'cd'.repeat(32)}5840${'ef'.repeat(64)}`;

// The demo stage run, in order, through the HTTP API exactly as the agent and the CFO console drive it.
export const CASES: Array<{ n: number; spec: Spec; cfo?: 'approve' | 'decline' }> = [
  { n: 1, spec: { id: 'A-0001', invoice: inv('INV-3821') } },
  { n: 2, spec: { id: 'A-0002', invoice: inv('INV-3822') }, cfo: 'approve' },
  { n: 3, spec: { id: 'A-0003', invoice: inv('INV-G-0042'), counterparty: ['globex', 'Globex (demo vendor)'] }, cfo: 'decline' },
  { n: 4, spec: { id: 'A-0004', invoice: inv('INV-3825') } },
  {
    n: 5,
    spec: { id: 'A-0005', invoice: null, amount: usdm('2'), type: 'purchase', purpose: 'digital_collectibles', counterparty: ['nft-marketplace', 'NFT marketplace'], recipient: ADDR.nft },
  },
  { n: 6, spec: { id: 'A-0006', invoice: inv('INV-3823'), recipient: ADDR.attacker, rationale: 'AWS billing emailed that their bank changed.' } },
  { n: 7, spec: { id: 'A-0007', invoice: inv('INV-3824') } },
];

export interface StageRow {
  n: number;
  outcome: string;
  reason: string | null;
  balance: bigint;
  spent: bigint;
}

export async function runStage(api: Api): Promise<{ run: string; rows: StageRow[] }> {
  const run = await api.agentRun();
  const rows: StageRow[] = [];
  const chain = api.chains.get(api.b001.vaultHash)!;
  for (const c of CASES) {
    const res = await api.checkPaying(
      { mandate_id: 'M-001', proposal: signed(action(c.spec, api.now())), execute: true, run_id: run },
      { idem: `stage:${run}:${c.spec.id}` },
    );
    if (res.status !== 200) throw new Error(`case ${c.n}: HTTP ${res.status} ${JSON.stringify(res.json)}`);
    let reason: string | null = res.json.evaluation.reason;
    if (c.cfo === 'approve') {
      const approved = await api.post(`/v1/approvals/${res.json.approval_id}/approve`, {});
      await api.post('/v1/executions', {
        approval_id: res.json.approval_id,
        authorization_digest: approved.json.authorization.digest_hex,
        cfo_witness_cbor: WITNESS,
      });
      await api.post(`/v1/approvals/${res.json.approval_id}/bond-submit`, { tx_hash: approved.json.bond_tx.tx_hash, cfo_witness_cbor: WITNESS });
    }
    if (c.cfo === 'decline') {
      const { wallet, address } = await cfoWallet();
      const sig = await wallet.signData(bytesToHex(utf8ToBytes(declineMessage(res.json.approval_id, 'legitimate'))), address);
      const declined = await api.post(`/v1/approvals/${res.json.approval_id}/decline`, { ...sig, reason: 'legitimate' });
      await api.post(`/v1/approvals/${res.json.approval_id}/bond-submit`, { tx_hash: declined.json.bond_tx.tx_hash, cfo_witness_cbor: WITNESS });
      reason = 'PRINCIPAL_DECLINED';
    }
    await api.executor.idle();
    rows.push({ n: c.n, outcome: res.json.evaluation.outcome, reason, balance: chain.balance, spent: chain.spent });
  }
  await api.post(`/v1/agent/runs/${run}/finish`, {}, { authorization: `Bearer ${AGENT_KEY}` });
  return { run, rows };
}
