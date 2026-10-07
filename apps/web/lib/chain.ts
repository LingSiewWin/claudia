import { config } from './config';

// Subset of the Koios tx_info response this app reads (verified against preprod.koios.rest).
export type PlutusJson =
  | { constructor: number; fields: PlutusJson[] }
  | { bytes: string }
  | { int: number }
  | { list: PlutusJson[] }
  | { map: Array<{ k: PlutusJson; v: PlutusJson }> };

export interface KoiosAsset {
  policy_id: string;
  asset_name: string;
  quantity: string;
}
export interface KoiosUtxo {
  payment_addr: { bech32: string; cred: string };
  asset_list: KoiosAsset[];
  inline_datum: { bytes: string | null; value: PlutusJson } | null;
}
export interface KoiosTx {
  tx_hash: string;
  block_height: number | null;
  reference_inputs: KoiosUtxo[];
  outputs: KoiosUtxo[];
  plutus_contracts: Array<{
    script_hash: string;
    valid_contract: boolean;
    input: { redeemer: { purpose: string; datum: { value: PlutusJson } } };
  }>;
  metadata: Record<string, unknown> | null;
}

export interface EthLog {
  address: string;
  topics: string[];
  data: string;
}
export interface EthReceipt {
  status: string;
  transactionHash: string;
  blockNumber: string;
  logs: EthLog[];
}

export async function koiosTx(txHash: string): Promise<KoiosTx | null> {
  const res = await fetch(`${config.koiosBase}/tx_info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _tx_hashes: [txHash], _inputs: true, _scripts: true, _metadata: true }),
  });
  if (!res.ok) throw new Error(`Koios HTTP ${res.status}`);
  const rows: unknown = await res.json();
  if (!Array.isArray(rows)) throw new Error('Koios returned an unexpected response');
  return (rows[0] as KoiosTx | undefined) ?? null;
}

export async function sepoliaReceipt(txHash: string): Promise<EthReceipt | null> {
  const res = await fetch(config.sepoliaRpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
  });
  if (!res.ok) throw new Error(`Sepolia RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: EthReceipt | null; error?: { message: string } };
  if (body.error) throw new Error(`Sepolia RPC: ${body.error.message}`);
  return body.result ?? null;
}

/** Field `index` of a constructor datum, or null when the shape is different. */
export function field(d: PlutusJson | undefined, index: number): PlutusJson | null {
  return d && 'fields' in d ? (d.fields[index] ?? null) : null;
}
export const bytesOf = (d: PlutusJson | null): string | null => (d && 'bytes' in d ? d.bytes : null);
export const intOf = (d: PlutusJson | null): number | null => (d && 'int' in d ? d.int : null);

/** True when any `bytes` node anywhere in the datum equals `hex`. Layout-independent search. */
export function containsBytes(d: PlutusJson | null | undefined, hex: string): boolean {
  if (typeof d !== 'object' || d === null) return false;
  if ('bytes' in d) return typeof d.bytes === 'string' && d.bytes.toLowerCase() === hex.toLowerCase();
  if ('fields' in d) return Array.isArray(d.fields) && d.fields.some((x) => containsBytes(x, hex));
  if ('list' in d) return Array.isArray(d.list) && d.list.some((x) => containsBytes(x, hex));
  if ('map' in d) return Array.isArray(d.map) && d.map.some((e) => containsBytes(e?.k, hex) || containsBytes(e?.v, hex));
  return false;
}

export const MANDATE_TOKEN_HEX = '4d414e44415445'; // "MANDATE"
