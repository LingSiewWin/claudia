import { hexToBytes } from '@authority/core';
import * as z from 'zod';

const UtxoSchema = z.object({
  address: z.string(),
  amount: z.array(z.object({ unit: z.string(), quantity: z.string().regex(/^\d+$/) })),
  collateral: z.boolean().optional(),
  reference: z.boolean().optional(),
});
// Blockfrost names the tx that created each spent input, and gives its inline datum as CBOR hex.
const InputSchema = UtxoSchema.extend({ tx_hash: z.string(), inline_datum: z.string().nullable().optional() });
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

// Top-level fields of a Plutus data Constr 0 (CBOR tag 121), each as its own CBOR hex; null for anything else.
// A minimal CBOR walk: Plutus data uses only integers, byte strings, arrays, maps and tags.
function constr0Fields(datumHex: string): string[] | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(datumHex)) return null;
  const b = hexToBytes(datumHex);
  let p = 0;
  const head = (): [major: number, n: number] => {
    const ib = b[p++];
    if (ib === undefined) throw new RangeError('truncated');
    const major = ib >> 5;
    const ai = ib & 31;
    if (ai < 24) return [major, ai];
    if (ai === 31 && (major === 2 || major === 4 || major === 5)) return [major, -1];
    if (ai > 27) throw new RangeError('bad header');
    let n = 0;
    for (let i = 0; i < 1 << (ai - 24); i++) {
      const x = b[p++];
      if (x === undefined) throw new RangeError('truncated');
      n = n * 256 + x;
    }
    if (!Number.isSafeInteger(n)) throw new RangeError('too large');
    return [major, n];
  };
  const item = (): void => {
    const [major, n] = head();
    if (major === 0 || major === 1) return;
    if (major === 6) return item();
    if (major === 2 && n >= 0) {
      p += n;
      if (p > b.length) throw new RangeError('truncated');
      return;
    }
    if (major !== 2 && major !== 4 && major !== 5) throw new RangeError('not Plutus data');
    if (n < 0) {
      while (b[p] !== 0xff) item();
      p++;
      return;
    }
    for (let i = 0; i < (major === 5 ? 2 * n : n); i++) item();
  };
  try {
    const [tagMajor, tag] = head();
    const [arrayMajor, count] = head();
    if (tagMajor !== 6 || tag !== 121 || arrayMajor !== 4) return null;
    const fields: string[] = [];
    while (count < 0 ? b[p] !== 0xff : fields.length < count) {
      const start = p;
      item();
      fields.push(datumHex.slice(2 * start, 2 * p));
    }
    if (count < 0) p++;
    return p === b.length ? fields : null;
  } catch {
    return null;
  }
}

// The payment contract's escrow datum is a 19-field Constr 0 whose field 10 is the purchase inputHash, kept unchanged
// by the result-submission datum. Exact field match: other fields (the buyer's COSE key) are 32-byte items too.
function escrowInputHashIs(datumHex: string | null | undefined, inputHash: string): boolean {
  const fields = datumHex ? constr0Fields(datumHex) : null;
  return fields?.length === 19 && fields[10] === `5820${inputHash}`;
}

// Seller payment proof: the collection tx is on-chain and passed script validation; it spent an escrow input that
// carries `unit`, was created by one of this payment's confirmed txs (`paymentTxHashes`, see confirmedTxHashes) and
// whose datum carries this purchase's `inputHash`; and it paid the seller at least `minUnits`. The payment service
// batches several collections into one tx, so netUnits is the seller's gain for the whole tx.
export async function verifyCollection(args: {
  txHash: string;
  sellerAddress: string;
  escrowAddress: string;
  unit: string;
  minUnits: bigint;
  inputHash: string;
  paymentTxHashes: readonly string[];
  blockfrostKey: string;
  fetchImpl?: typeof fetch;
}): Promise<CollectionProof> {
  if (!/^[0-9a-f]{64}$/.test(args.txHash)) throw new CollectionError('txHash must be 64 lowercase hex chars');
  if (!(args.minUnits > 0n)) throw new TypeError('minUnits must be positive');
  if (!/^[0-9a-f]{64}$/.test(args.inputHash)) throw new TypeError('inputHash must be 64 lowercase hex chars');
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
  const fromPayment = escrow.filter((u) => args.paymentTxHashes.includes(u.tx_hash));
  if (fromPayment.length === 0) throw new CollectionError("collection tx spends no escrow output created by this payment's transactions");
  if (!fromPayment.some((u) => escrowInputHashIs(u.inline_datum, args.inputHash))) {
    throw new CollectionError("collection tx spends no escrow output whose datum carries this purchase's inputHash");
  }
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
