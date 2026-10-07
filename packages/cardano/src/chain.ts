import {
  BlockfrostProvider,
  type IEvaluator,
  type IFetcher,
  type Protocol,
  SLOT_CONFIG_NETWORK,
  core,
  slotToBeginUnixTime,
  unixTimeToEnclosingSlot,
} from '@meshsdk/core';

export const BLOCKFROST = 'https://cardano-preprod.blockfrost.io/api/v0';
const SLOTS = SLOT_CONFIG_NETWORK.preprod;

/** POSIX ms <-> preprod slot (1 s slots). `slotAt` rounds down, so msAt(slotAt(t)) <= t. */
export const slotAt = (ms: number): number => unixTimeToEnclosingSlot(ms, SLOTS);
export const msAt = (slot: number): number => slotToBeginUnixTime(slot, SLOTS);

/** What the tx builder needs. Tests pass an offline env; scripts pass a `Chain`. */
export interface TxEnv {
  params: Protocol;
  evaluator: IEvaluator;
  fetcher?: IFetcher;
}

export interface Chain extends TxEnv {
  provider: BlockfrostProvider;
  projectId: string;
}

export async function connect(projectId: string | undefined): Promise<Chain> {
  if (!projectId?.startsWith('preprod')) throw new Error('BLOCKFROST_PROJECT_ID_PREPROD must be a preprod project id');
  const provider = new BlockfrostProvider(projectId);
  const [params, costModels] = await Promise.all([provider.fetchProtocolParameters(), provider.fetchCostModels()]);
  // Local Plutus evaluation with the chain's own cost models; it reports script traces on failure.
  const evaluator = new core.OfflineEvaluatorScalus(provider, 'preprod', undefined, costModels);
  return { params, evaluator, fetcher: provider, provider, projectId };
}

export type Evaluation =
  | { ok: true; budgets: { tag: string; index: number; budget: { mem: number; steps: number } }[] }
  | { ok: false; logs: string[]; message: string };

/** Runs every script in the tx. A failing script yields its trace lines (e.g. "r16 ? False"). */
export async function evaluateTx(env: TxEnv, txHex: string): Promise<Evaluation> {
  try {
    return { ok: true, budgets: await env.evaluator.evaluateTx(txHex) };
  } catch (error) {
    const e = error as { message?: unknown; logs?: unknown };
    const logs = Array.isArray(e.logs) ? e.logs.map(String) : [];
    return { ok: false, logs, message: String(e.message ?? error) };
  }
}

export interface SubmitResult {
  ok: boolean;
  status: number;
  body: string;
}

/** POST /tx/submit with the raw body kept, so a node rejection can be logged verbatim. */
export async function submitRaw(chain: Chain, txHex: string): Promise<SubmitResult> {
  const res = await fetch(`${BLOCKFROST}/tx/submit`, {
    method: 'POST',
    headers: { project_id: chain.projectId, 'Content-Type': 'application/cbor' },
    body: Buffer.from(txHex, 'hex'),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

export async function submit(chain: Chain, txHex: string): Promise<string> {
  const r = await submitRaw(chain, txHex);
  if (!r.ok) throw new Error(`submit rejected (${r.status}): ${r.body.slice(0, 4000)}`);
  return JSON.parse(r.body) as string;
}

/** GET /txs/{hash}: block height if the tx is on chain, otherwise null (404). */
export async function txOnChain(chain: Chain, txHash: string): Promise<{ block_height: number } | null> {
  const res = await fetch(`${BLOCKFROST}/txs/${txHash}`, { headers: { project_id: chain.projectId } });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`txOnChain ${txHash}: ${res.status} ${await res.text()}`);
  const body = JSON.parse(await res.text()) as { block_height?: number };
  return { block_height: Number(body.block_height) };
}

/** Polls GET /txs/{hash} until the tx is in a block. */
export async function awaitTx(chain: Chain, txHash: string, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await txOnChain(chain, txHash);
    if (info) return;
    if (Date.now() > deadline) throw new Error(`awaitTx ${txHash}: not in a block after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

export async function tipSlot(chain: Chain): Promise<number> {
  return Number((await chain.provider.fetchLatestBlock()).slot);
}
