import * as z from 'zod';

const UtxoSchema = z.object({
  address: z.string(),
  amount: z.array(z.object({ unit: z.string(), quantity: z.string().regex(/^\d+$/) })),
  collateral: z.boolean().optional(),
  reference: z.boolean().optional(),
});
// Blockfrost names the tx that created each spent input.
const InputSchema = UtxoSchema.extend({ tx_hash: z.string() });
const TxUtxosSchema = z.object({ hash: z.string(), inputs: z.array(InputSchema), outputs: z.array(UtxoSchema) });
export type TxUtxos = z.infer<typeof TxUtxosSchema>;

// The tx can never prove this collection. Fetch and API failures stay plain Errors and may be retried.
export class CollectionError extends Error {}

// Net units of `unit` the seller address gained in this tx. Collateral and reference entries are ignored,
// and the seller's own inputs are subtracted so change cannot inflate the receipt.
export function sellerNetUnits(tx: TxUtxos, sellerAddress: string, unit: string): bigint {
  const total = (list: TxUtxos['outputs']): bigint =>
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

// Seller payment proof: the collection tx is on-chain, passed script validation, spent an escrow output created by
// one of this payment's confirmed txs (`paymentTxHashes`, see confirmedTxHashes), and paid the seller at least
// `minUnits`. The payment service batches several collections into one tx, so netUnits can exceed one price.
export async function verifyCollection(args: {
  txHash: string;
  sellerAddress: string;
  escrowAddress: string;
  unit: string;
  minUnits: bigint;
  paymentTxHashes: readonly string[];
  blockfrostKey: string;
  fetchImpl?: typeof fetch;
}): Promise<CollectionProof> {
  if (!/^[0-9a-f]{64}$/.test(args.txHash)) throw new CollectionError('txHash must be 64 lowercase hex chars');
  if (!(args.minUnits > 0n)) throw new TypeError('minUnits must be positive');
  const get = async (path: string): Promise<unknown> => {
    const res = await (args.fetchImpl ?? fetch)(`${BLOCKFROST_PREPROD}${path}`, {
      redirect: 'error',
      headers: { project_id: args.blockfrostKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Blockfrost ${path} HTTP ${res.status}`);
    return res.json();
  };
  const tx = z.object({ hash: z.string(), block_height: z.number().int(), valid_contract: z.boolean() }).parse(await get(`/txs/${args.txHash}`));
  if (tx.hash !== args.txHash) throw new Error('Blockfrost returned a different transaction');
  if (!tx.valid_contract) throw new CollectionError('collection tx failed script validation');
  const utxos = TxUtxosSchema.parse(await get(`/txs/${args.txHash}/utxos`));
  if (utxos.hash !== args.txHash) throw new Error('Blockfrost returned a different transaction');
  const escrow = utxos.inputs.filter(
    (u) => u.address === args.escrowAddress && u.collateral !== true && u.reference !== true && u.amount.some((a) => a.unit === args.unit),
  );
  if (escrow.length === 0) throw new CollectionError('collection tx spends no escrow input carrying the unit');
  if (!escrow.some((u) => args.paymentTxHashes.includes(u.tx_hash))) throw new CollectionError('collection tx spends no escrow output of this payment');
  const net = sellerNetUnits(utxos, args.sellerAddress, args.unit);
  if (net < args.minUnits) throw new CollectionError(`collection tx does not pay the seller ${args.minUnits} units`);
  return {
    txHash: args.txHash,
    explorer: `https://preprod.cardanoscan.io/transaction/${args.txHash}`,
    sellerAddress: args.sellerAddress,
    unit: args.unit,
    netUnits: net.toString(),
    blockHeight: tx.block_height,
  };
}
