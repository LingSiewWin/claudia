// Local CIP-30 signing page: the CLI builds every admin tx, the human signs it in Lace, the key never leaves Lace.
import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { core, deserializeAddress } from '@meshsdk/core';
import type { TxPlan } from './build';
import { PREPROD_USDM } from './deployment';

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
  /** Optional: tell the page a signed transaction is in a block, so its card reads "confirmed". */
  confirm(txHash: string): void;
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

const USDM_UNIT = `${PREPROD_USDM.policy}${PREPROD_USDM.name}`;

/** Inline CSS only: the page is served on 127.0.0.1 and must not load anything from the network. */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claudia admin signing</title>
<style>
:root{--mist:#e9ecea;--raised:#f6f7f5;--ink:#16201c;--muted:#5b6662;--line:rgb(22 32 28 / .14);--permit:#1f7a55;--cosign:#b7791f;--forbid:#b42318}
*{box-sizing:border-box}
body{margin:0;background:var(--mist);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:52rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.5rem 1.5rem;border-bottom:1px solid var(--line);padding-bottom:1rem}
header b{font-weight:800;letter-spacing:-.01em}
header span{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
h1{font:400 2.6rem/1.02 ui-serif,Georgia,"Times New Roman",serif;letter-spacing:-.02em;margin:2rem 0 .5rem}
h1 em{color:var(--muted)}
#lede{color:var(--muted);margin:0 0 2rem;max-width:36rem}
#status{display:inline-flex;align-items:center;gap:.5rem;font-weight:700;margin:0}
#status::before{content:"";width:.6rem;height:.6rem;border-radius:999px;background:var(--muted)}
#status[data-tone=ready]::before{background:var(--cosign)}
#status[data-tone=sent]::before{background:var(--permit)}
#status[data-tone=refused]::before{background:var(--forbid)}
#status[data-tone=refused]{color:var(--forbid)}
.card{margin-top:1.25rem;border:1px solid var(--line);border-radius:14px;background:var(--raised);padding:1.25rem}
.card.done{opacity:.6}
.card h2{margin:0;font-size:1.25rem;letter-spacing:-.01em}
.card .what{margin:.25rem 0 0;color:var(--muted)}
.card dl{margin:1rem 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.card dl>div{display:grid;grid-template-columns:9rem 1fr;gap:1rem;padding:.5rem 0;border-top:1px solid var(--line)}
.card dl>div:first-child{border-top:0}
.card dt{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding-top:.15rem}
.card dd{margin:0;min-width:0}
.card li,.hex{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.card ul{margin:0;padding:0;list-style:none}
.card li+li{margin-top:.25rem}
.amount{font-weight:800;font-variant-numeric:tabular-nums;font-family:ui-sans-serif,system-ui,sans-serif;font-size:15px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1rem;margin-top:1rem}
.chip{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;border:1px solid var(--line);border-radius:4px;padding:.1rem .4rem}
.chip.sent{color:var(--permit)}.chip.confirmed{color:var(--permit);border-color:var(--permit)}.chip.refused{color:var(--forbid)}
button{appearance:none;border:0;border-radius:6px;background:var(--ink);color:var(--mist);font:800 17px/1 inherit;letter-spacing:-.01em;padding:.8rem 1.4rem;cursor:pointer}
button:disabled{opacity:.4;cursor:not-allowed}
button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
footer{margin-top:3rem;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted);font-size:13px}
</style></head>
<body><main>
<header><b>Claudia admin signing</b><span>Cardano preprod · 127.0.0.1</span></header>
<h1>Sign what the CLI built. <em>The key stays in Lace.</em></h1>
<p id="lede">Each transaction below was built and checked by the CLI on this machine. Compare the amounts and the recipient with what Lace shows before you sign.</p>
<p id="status" data-tone="wait">Waiting for the CLI…</p>
<section id="cards" aria-label="Pending transactions"></section>
<footer>The page is served once under a random path and polls the CLI once a second. Nothing here reaches the network except through Lace.</footer>
</main>
<script type="module">
const base = location.pathname.replace(/\\/$/, '');
const $ = (id) => document.getElementById(id);
const USDM = ${JSON.stringify(USDM_UNIT)};
const TITLE = [
  ['anchor', 'Anchor the mandate', 'Mints the mandate anchor token the vault reads on every release.'],
  ['vault', 'Mint the treasury vault', 'Mints the vault token and locks the treasury behind the mandate.'],
  ['update', 'Update the mandate', 'Replaces the anchored limits with a new mandate version.'],
  ['revoke', 'Revoke the mandate', 'Marks the mandate revoked so no further release can pass the vault.'],
  ['fund', 'Fund the wallets', 'Sends ADA from the admin wallet to the wallets the run needs.'],
];
const fmt = (units, decimals) => {
  const s = String(units).padStart(decimals + 1, '0');
  return (s.slice(0, -decimals) + '.' + s.slice(-decimals)).replace(/\\.?0+$/, (m) => (m === '.' + '0'.repeat(decimals) ? '.00' : m.startsWith('.') ? '' : m)).replace(/\\.$/, '');
};
const money = (line) => line
  .replace(/(\\d+) lovelace/g, (_, n) => '<span class="amount">' + fmt(n, 6) + ' ADA</span>')
  .replace(new RegExp('(\\\\d+) ' + USDM, 'g'), (_, n) => '<span class="amount">' + fmt(n, 6) + ' USDM</span>');
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const describe = (label) => TITLE.find(([k]) => label.toLowerCase().includes(k)) || [null, label, 'An admin transaction built by the CLI.'];
const status = (text, tone) => { $('status').textContent = text; $('status').dataset.tone = tone; };
let api = null;
async function wallet() {
  if (api) return api;
  const lace = window.cardano && window.cardano.lace;
  if (!lace) throw new Error('Lace is not available in this browser');
  api = await lace.enable();
  return api;
}
const post = (body) => fetch(base + '/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function card(job) {
  const [, title, what] = describe(job.label);
  const el = document.createElement('article');
  el.className = 'card';
  el.id = 'job-' + job.id;
  el.innerHTML = '<h2>' + esc(title) + '</h2><p class="what">' + esc(what) + '</p>'
    + '<dl><div><dt>Transaction</dt><dd class="hex">' + esc(job.txHash) + '</dd></div>'
    + '<div><dt>What it does</dt><dd><ul>' + job.summary.map((l) => '<li>' + money(esc(l)) + '</li>').join('') + '</ul></dd></div>'
    + '<div><dt>Must be signed by</dt><dd class="hex">' + esc(job.signer) + '</dd></div></dl>'
    + '<div class="row"><button type="button">Sign in Lace</button><span class="chip">waiting for your signature</span></div>';
  return el;
}
function connectCard(job) {
  const el = document.createElement('article');
  el.className = 'card';
  el.id = 'job-' + job.id;
  el.innerHTML = '<h2>Connect the admin wallet</h2><p class="what">Open Lace on the Preprod network and connect the wallet that holds the admin key.</p>'
    + '<div class="row"><button type="button">Connect Lace</button><span class="chip">waiting</span></div>';
  return el;
}
async function run(job, el) {
  const button = el.querySelector('button');
  const chip = el.querySelector('.chip');
  button.disabled = true;
  try {
    const a = await wallet();
    const value = job.kind === 'connect'
      ? { networkId: await a.getNetworkId(), changeAddress: await a.getChangeAddress() }
      : await a.signTx(job.txHex, true);
    await post({ id: job.id, ok: true, value });
    chip.textContent = 'sent to CLI';
    chip.className = 'chip sent';
    el.classList.add('done');
    status('Sent to the CLI. Waiting for the next step…', 'sent');
  } catch (e) {
    const error = String((e && (e.info || e.message)) || e);
    await post({ id: job.id, ok: false, error, code: e && e.code });
    chip.textContent = 'refused';
    chip.className = 'chip refused';
    button.disabled = false;
    status('Refused: ' + error, 'refused');
  }
}
let shown = -1;
for (;;) {
  const job = await (await fetch(base + '/job')).json();
  for (const hash of job.confirmed || []) {
    const chip = document.querySelector('[data-hash="' + hash + '"] .chip');
    if (chip && chip.textContent !== 'confirmed') { chip.textContent = 'confirmed'; chip.className = 'chip confirmed'; }
  }
  if (job.kind !== 'wait' && job.id !== shown) {
    shown = job.id;
    const el = job.kind === 'connect' ? connectCard(job) : card(job);
    if (job.txHash) el.dataset.hash = job.txHash;
    el.querySelector('button').onclick = () => run(job, el);
    $('cards').prepend(el);
    status(job.kind === 'connect' ? 'Connect the CFO admin wallet in Lace (network: Preprod).' : describe(job.label)[1] + ' is ready to sign.', 'ready');
  }
  await new Promise((r) => setTimeout(r, 1000));
}
</script></body></html>`;

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

/** Serves the signing page on 127.0.0.1 under a one-time random path. One job at a time. */
export async function openLaceSession(port = 0, timeoutMs = Number(process.env.LACE_SIGN_TIMEOUT_MS ?? 60 * 60_000)): Promise<LaceSession> {
  const token = randomBytes(16).toString('hex');
  let job: Job | null = null;
  let serial = 0;
  let settle: ((r: Result) => void) | null = null;
  let host = '';
  const confirmed: string[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, type: string, text: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(text);
    };
    if (req.headers.host !== host) return send(421, 'text/plain', 'wrong host');
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && (path === `/${token}` || path === `/${token}/`)) return send(200, 'text/html; charset=utf-8', PAGE);
    if (req.method === 'GET' && path === `/${token}/job`) return send(200, 'application/json', JSON.stringify({ ...(job ?? { kind: 'wait' }), confirmed }));
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
    confirm: (txHash) => {
      confirmed.push(txHash);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
