// Local CIP-30 signing page: the CLI builds every admin tx, the human signs it in Lace, the key never leaves Lace.
import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { core, deserializeAddress } from '@meshsdk/core';
import type { TxPlan } from './build';

export interface LaceAccount {
  address: string;
  pkh: string;
}

export interface SignRequest {
  label: string;
  txHex: string;
  txHash: string;
  /** The admin key hash the plan requires; shown on the page, checked again when the witness is merged. */
  signer: string;
  summary: string[];
}

type Job = { id: number; kind: 'connect' } | ({ id: number; kind: 'sign' } & SignRequest);
type Result = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string; code?: number };

export interface LaceSession {
  url: string;
  connect(): Promise<LaceAccount>;
  /** Resolves with the CIP-30 `signTx(tx, true)` witness set (hex). */
  sign(req: SignRequest): Promise<string>;
  close(): Promise<void>;
}

/** What the page shows next to the Lace popup, so the human can compare both. */
export function planSummary(plan: TxPlan): string[] {
  const amount = (a: { unit: string; quantity: string }[]) => a.map((x) => `${x.quantity} ${x.unit === 'lovelace' ? 'lovelace' : x.unit}`).join(' + ') || 'min ADA';
  return [
    ...plan.mints.map((m) => `mint ${m.quantity} ${m.policy}.${m.name}`),
    ...plan.scriptInputs.map((s) => `spend script UTxO ${s.utxo.input.txHash}#${s.utxo.input.outputIndex}`),
    ...plan.outputs.map((o) => `pay ${amount(o.amount)} to ${o.address}${o.datum ? ' (inline datum)' : ''}${o.referenceScript ? ' (reference script)' : ''}`),
    `required signers: ${plan.requiredSigners.join(', ') || 'none'}`,
    `change to ${plan.wallet.address}`,
  ];
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Admin signing (preprod)</title>
<body style="font:14px system-ui;max-width:820px;margin:40px auto">
<h1>Admin signing (preprod)</h1><p id="status">Waiting for the CLI...</p><pre id="summary" style="white-space:pre-wrap"></pre>
<button id="go" hidden></button>
<script type="module">
const base = location.pathname.replace(/\\/$/, '');
const $ = (id) => document.getElementById(id);
let api = null;
async function wallet() {
  if (api) return api;
  const lace = window.cardano && window.cardano.lace;
  if (!lace) throw new Error('Lace is not available in this browser');
  api = await lace.enable();
  return api;
}
const post = (body) => fetch(base + '/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function run(job) {
  $('go').hidden = true;
  try {
    const a = await wallet();
    const value = job.kind === 'connect'
      ? { networkId: await a.getNetworkId(), changeAddress: await a.getChangeAddress() }
      : await a.signTx(job.txHex, true);
    await post({ id: job.id, ok: true, value });
    $('status').textContent = 'Sent to the CLI. Waiting for the next step...';
  } catch (e) {
    const error = String((e && (e.info || e.message)) || e);
    await post({ id: job.id, ok: false, error, code: e && e.code });
    $('status').textContent = 'Refused: ' + error;
  }
}
let shown = -1;
for (;;) {
  const job = await (await fetch(base + '/job')).json();
  if (job.kind !== 'wait' && job.id !== shown) {
    shown = job.id;
    $('status').textContent = job.kind === 'connect' ? 'Connect the CFO admin wallet in Lace (network: Preprod).' : job.label + ', tx ' + job.txHash;
    $('summary').textContent = job.kind === 'sign' ? job.summary.join('\\n') + '\\nadmin key hash that must sign: ' + job.signer : '';
    $('go').textContent = job.kind === 'connect' ? 'Connect Lace' : 'Sign in Lace';
    $('go').onclick = () => run(job);
    $('go').hidden = false;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
</script>`;

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

/** Serves the signing page on 127.0.0.1 under a one-time random path. One job at a time. */
export async function openLaceSession(port = 0, timeoutMs = 15 * 60_000): Promise<LaceSession> {
  const token = randomBytes(16).toString('hex');
  let job: Job | null = null;
  let serial = 0;
  let settle: ((r: Result) => void) | null = null;
  let host = '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, type: string, text: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(text);
    };
    if (req.headers.host !== host) return send(421, 'text/plain', 'wrong host');
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && (path === `/${token}` || path === `/${token}/`)) return send(200, 'text/html; charset=utf-8', PAGE);
    if (req.method === 'GET' && path === `/${token}/job`) return send(200, 'application/json', JSON.stringify(job ?? { kind: 'wait' }));
    if (req.method === 'POST' && path === `/${token}/result`) {
      void body(req).then((text) => {
        const r = JSON.parse(text) as Result;
        if (!job || r.id !== job.id || !settle) return send(409, 'text/plain', 'no such job');
        const done = settle;
        job = null;
        settle = null;
        done(r);
        send(200, 'text/plain', 'ok');
      });
      return;
    }
    send(404, 'text/plain', 'not found');
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('signing page: no TCP port');
  host = `127.0.0.1:${address.port}`;

  const ask = (next: Job): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (job) return reject(new Error('signing page: a job is already pending'));
      const timer = setTimeout(() => {
        job = null;
        settle = null;
        reject(new Error(`signing page: no answer from Lace after ${timeoutMs} ms`));
      }, timeoutMs);
      job = next;
      settle = (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r.value);
        else reject(new Error(`Lace refused (${r.code ?? 'no code'}): ${r.error}`));
      };
    });

  return {
    url: `http://${host}/${token}/`,
    connect: async () => {
      const v = (await ask({ id: ++serial, kind: 'connect' })) as { networkId: number; changeAddress: string };
      if (v.networkId !== 0) throw new Error(`Lace is on network ${v.networkId}; switch it to Preprod`);
      const addr = core.Address.fromBytes(v.changeAddress as Parameters<typeof core.Address.fromBytes>[0]);
      if (addr.getNetworkId() !== 0) throw new Error('Lace returned a mainnet address');
      const bech32 = addr.toBech32();
      return { address: bech32, pkh: deserializeAddress(bech32).pubKeyHash };
    },
    sign: async (req) => {
      const v = await ask({ id: ++serial, kind: 'sign', ...req });
      if (typeof v !== 'string' || !/^[0-9a-f]+$/.test(v)) throw new Error('Lace returned no witness set');
      return v;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
