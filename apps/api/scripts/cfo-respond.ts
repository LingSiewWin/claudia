// Plays the CFO console for a live agent run: answers pending approvals by invoice number with the CFO test
// wallet (CIP-30-equivalent partial tx signature to approve, CIP-8 signData to decline), then exits.
// Usage: pnpm --filter @authority/api cfo approve INV-3822 decline INV-G-0042
// Env: AUTHORITY_API_URL, CFO_TEST_MNEMONIC
import { setTimeout as sleep } from 'node:timers/promises';
import { bytesToHex, utf8ToBytes } from '@authority/core';
import { deserializeAddress, MeshWallet } from '@meshsdk/core';
import { declineMessage } from '../src/approvals';

const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const args = process.argv.slice(2).filter((a) => a !== '--');
const choices = new Map<string, 'approve' | 'decline'>();
for (let i = 0; i < args.length; i += 2) {
  const verb = args[i];
  const number = args[i + 1];
  if ((verb !== 'approve' && verb !== 'decline') || !number) throw new Error('usage: cfo (approve|decline) <invoice number> ...');
  choices.set(number, verb);
}
if (choices.size === 0) throw new Error('usage: cfo (approve|decline) <invoice number> ...');
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

const cfo = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: need('CFO_TEST_MNEMONIC').split(/\s+/) } });
await cfo.init();
const cfoAddress = await cfo.getChangeAddress();
const view = await call('GET', '/v1/mandates/M-001');
const approver = view.mandate.approvers.find((a: { role: string }) => a.role === 'CFO').cardano_key_hash;
if (deserializeAddress(cfoAddress).pubKeyHash !== approver) throw new Error('CFO_TEST_MNEMONIC is not the M-001 CFO approver');

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
      const sig = await cfo.signData(bytesToHex(utf8ToBytes(declineMessage(ap.approval_id))), cfoAddress);
      await call('POST', `/v1/approvals/${ap.approval_id}/decline`, sig);
      console.log(JSON.stringify({ declined: ap.approval_id, invoice: number, action_id: ap.action.id }));
    }
    handled.add(number);
  }
  await sleep(3_000);
}
