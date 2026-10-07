// Plays the CFO console for a live agent run: answers pending approvals by invoice number with the CFO test
// wallet (CIP-30-equivalent partial tx signature to approve, CIP-8 signData to decline), then exits.
// Usage: pnpm --filter @authority/api cfo [--mandate M-001|M-LAB] (approve|decline|frivolous) <invoice number> ...
//   decline refunds the bond (reasonable ask); frivolous captures it. M-LAB uses M_LAB_APPROVER_MNEMONIC.
// Env: AUTHORITY_API_URL, CFO_TEST_MNEMONIC (M-001) or M_LAB_APPROVER_MNEMONIC (M-LAB)
import { setTimeout as sleep } from 'node:timers/promises';
import { bytesToHex, utf8ToBytes } from '@authority/core';
import { deserializeAddress, MeshWallet } from '@meshsdk/core';
import { declineMessage } from '../src/approvals';

const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const argv = process.argv.slice(2).filter((a) => a !== '--');
const mandateFlag = argv.indexOf('--mandate');
const mandateId = mandateFlag >= 0 ? (argv[mandateFlag + 1] ?? '') : 'M-001';
if (mandateId !== 'M-001' && mandateId !== 'M-LAB') throw new Error('--mandate must be M-001 or M-LAB');
const args = mandateFlag >= 0 ? [...argv.slice(0, mandateFlag), ...argv.slice(mandateFlag + 2)] : argv;
type Verb = 'approve' | 'decline' | 'frivolous';
const choices = new Map<string, Verb>();
for (let i = 0; i < args.length; i += 2) {
  const verb = args[i];
  const number = args[i + 1];
  if ((verb !== 'approve' && verb !== 'decline' && verb !== 'frivolous') || !number) throw new Error('usage: cfo [--mandate M-001|M-LAB] (approve|decline|frivolous) <invoice number> ...');
  choices.set(number, verb);
}
if (choices.size === 0) throw new Error('usage: cfo [--mandate M-001|M-LAB] (approve|decline|frivolous) <invoice number> ...');
const walletEnv = mandateId === 'M-001' ? 'CFO_TEST_MNEMONIC' : 'M_LAB_APPROVER_MNEMONIC';
const api = need('AUTHORITY_API_URL').replace(/\/+$/, '');

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(600_000),
  });
  const json = res.status === 204 ? null : ((await res.json()) as any);
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const cfo = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: need(walletEnv).split(/\s+/) } });
await cfo.init();
const cfoAddress = await cfo.getChangeAddress();
const view = await call('GET', `/v1/mandates/${mandateId}`);
const approver = view.mandate.approvers.find((a: { role: string }) => a.role === 'CFO').cardano_key_hash;
if (deserializeAddress(cfoAddress).pubKeyHash !== approver) throw new Error(`${walletEnv} is not the ${mandateId} CFO approver`);

console.log(JSON.stringify({ waiting_for: Object.fromEntries(choices) }));
const handled = new Set<string>();
const deadline = Date.now() + 30 * 60_000;
while (handled.size < choices.size) {
  if (Date.now() > deadline) throw new Error(`no approval seen within 30 minutes for ${[...choices.keys()].filter((n) => !handled.has(n)).join(', ')}`);
  const { approvals } = await call('GET', '/v1/approvals?status=pending');
  for (const ap of approvals as Array<{ approval_id: string; action: { id: string; reference?: { invoice_number: string } } }>) {
    const number = ap.action.reference?.invoice_number;
    const verb = number === undefined ? undefined : choices.get(number);
    if (number === undefined || verb === undefined || handled.has(number)) continue;
    if (verb === 'approve') {
      const approved = await call('POST', `/v1/approvals/${ap.approval_id}/approve`, {});
      const witness = await cfo.signTx(approved.unsigned_tx_cbor, true, false);
      await call('POST', '/v1/executions', { approval_id: ap.approval_id, authorization_digest: approved.authorization.digest_hex, cfo_witness_cbor: witness });
      console.log(JSON.stringify({ approved: ap.approval_id, invoice: number, action_id: ap.action.id, tx_hash: approved.tx_hash, requires_principal: approved.authorization.fields.requires_principal }));
    } else {
      // A declined reasonable ask refunds the bond to the agent; a frivolous one captures it to the sink.
      const reason = verb === 'frivolous' ? 'frivolous' : 'legitimate';
      const sig = await cfo.signData(bytesToHex(utf8ToBytes(declineMessage(ap.approval_id, reason))), cfoAddress);
      const declined = await call('POST', `/v1/approvals/${ap.approval_id}/decline`, { ...sig, reason });
      let bond_tx: string | null = null;
      if (declined.bond_tx) {
        const witness = await cfo.signTx(declined.bond_tx.unsigned_tx_cbor, true, false);
        bond_tx = (await call('POST', `/v1/approvals/${ap.approval_id}/bond-submit`, { tx_hash: declined.bond_tx.tx_hash, cfo_witness_cbor: witness })).tx_hash;
      }
      console.log(JSON.stringify({ declined: ap.approval_id, invoice: number, action_id: ap.action.id, reason, bond_tx }));
    }
    handled.add(number);
  }
  await sleep(3_000);
}
