import * as z from 'zod';

const UtxoSchema = z.object({
  address: z.string(),
  amount: z.array(z.object({ unit: z.string(), quantity: z.string().regex(/^\d+$/) })),
  collateral: z.boolean().optional(),
  reference: z.boolean().optional(),
});
const TxUtxosSchema = z.object({ hash: z.string(), inputs: z.array(UtxoSchema), outputs: z.array(UtxoSchema) });
export type TxUtxos = z.infer<typeof TxUtxosSchema>;

// Net units of `unit` the seller address gained in this tx. Collateral and reference entries are ignored,
// and the seller's own inputs are subtracted so change cannot inflate the receipt.
export function sellerNetUnits(tx: TxUtxos, sellerAddress: string, unit: string): bigint {
  const total = (list: TxUtxos['inputs']): bigint =>
    list
      .filter((u) => u.address === sellerAddress && u.collateral !== true && u.reference !== true)
      .flatMap((u) => u.amount)
      .filter((a) => a.unit === unit)
      .reduce((n, a) => n + BigInt(a.quantity), 0n);
  return total(tx.outputs) - total(tx.inputs);
}

export interface CollectionProof {
  txHash: string;
  explorer: string;
  sellerAddress: string;
  unit: string;
  netUnits: string;
  blockHeight: number;
}

const BLOCKFROST_PREPROD = 'https://cardano-preprod.blockfrost.io/api/v0';

// Seller payment proof: the collection tx is on-chain, passed script validation, and paid the seller.
export async function verifyCollection(args: {
  txHash: string;
  sellerAddress: string;
  unit: string;
  blockfrostKey: string;
  fetchImpl?: typeof fetch;
}): Promise<CollectionProof> {
  if (!/^[0-9a-f]{64}$/.test(args.txHash)) throw new Error('txHash must be 64 lowercase hex chars');
  const get = async (path: string): Promise<unknown> => {
    const res = await (args.fetchImpl ?? fetch)(`${BLOCKFROST_PREPROD}${path}`, {
      headers: { project_id: args.blockfrostKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Blockfrost ${path} HTTP ${res.status}`);
    return res.json();
  };
  const tx = z.object({ block_height: z.number().int(), valid_contract: z.boolean() }).parse(await get(`/txs/${args.txHash}`));
  if (!tx.valid_contract) throw new Error('collection tx failed script validation');
  const utxos = TxUtxosSchema.parse(await get(`/txs/${args.txHash}/utxos`));
  if (utxos.hash !== args.txHash) throw new Error('Blockfrost returned a different transaction');
  const net = sellerNetUnits(utxos, args.sellerAddress, args.unit);
  if (net <= 0n) throw new Error('collection tx does not pay the seller');
  return {
    txHash: args.txHash,
    explorer: `https://preprod.cardanoscan.io/transaction/${args.txHash}`,
    sellerAddress: args.sellerAddress,
    unit: args.unit,
    netUnits: net.toString(),
    blockHeight: tx.block_height,
  };
}
