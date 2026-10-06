import { describe, expect, it } from 'vitest';
import { TEST_USDM_UNIT } from '../src/mps';
import { sellerNetUnits, verifyCollection, type TxUtxos } from '../src/settlement';

const SELLER = 'addr_test1qseller';
const SCRIPT = 'addr_test1wzescrow';
const U = TEST_USDM_UNIT;
const HASH = '64a9b1a031d220fb48653171fe8989d722ad25c05c8c5e26287ca15e0fa08bed';
const coins = (lovelace: string, usdm?: string) => [{ unit: 'lovelace', quantity: lovelace }, ...(usdm ? [{ unit: U, quantity: usdm }] : [])];

// Same shape as the reference seller collection tx 64a9b1a0... on preprod (Blockfrost /txs/{hash}/utxos).
const collection: TxUtxos = {
  hash: HASH,
  inputs: [
    { address: SCRIPT, amount: coins('2000000', '1000000'), collateral: false, reference: false },
    { address: SELLER, amount: coins('5000000'), collateral: false, reference: false },
    { address: SELLER, amount: coins('5000000'), collateral: true, reference: false },
  ],
  outputs: [
    { address: SELLER, amount: coins('1500000', '1000000'), collateral: false },
    { address: 'addr_test1qfee', amount: coins('1000000'), collateral: false },
    { address: SELLER, amount: coins('4300000'), collateral: false },
    { address: SELLER, amount: coins('4800000'), collateral: true },
  ],
};

describe('sellerNetUnits', () => {
  it('measures the escrowed tUSDM reaching the seller', () => {
    expect(sellerNetUnits(collection, SELLER, U)).toBe(1_000_000n);
  });

  it('seller change does not inflate the receipt', () => {
    const tx: TxUtxos = {
      hash: HASH,
      inputs: [{ address: SELLER, amount: coins('2000000', '100') }],
      outputs: [{ address: SELLER, amount: coins('1000000', '101') }, { address: 'addr_test1qbuyer', amount: coins('900000', '99') }],
    };
    expect(sellerNetUnits(tx, SELLER, U)).toBe(1n);
  });

  it('ignores collateral outputs', () => {
    const tx: TxUtxos = { hash: HASH, inputs: [], outputs: [{ address: SELLER, amount: coins('1', '500'), collateral: true }] };
    expect(sellerNetUnits(tx, SELLER, U)).toBe(0n);
  });
});

describe('verifyCollection', () => {
  const blockfrost = (tx: unknown, utxos: unknown) =>
    (async (url: string | URL | Request) =>
      new Response(JSON.stringify(String(url).endsWith('/utxos') ? utxos : tx), { status: 200 })) as typeof fetch;

  it('returns the proof for a valid collection tx', async () => {
    const proof = await verifyCollection({ txHash: HASH, sellerAddress: SELLER, unit: U, blockfrostKey: 'k', fetchImpl: blockfrost({ block_height: 5257129, valid_contract: true }, collection) });
    expect(proof).toEqual({ txHash: HASH, explorer: `https://preprod.cardanoscan.io/transaction/${HASH}`, sellerAddress: SELLER, unit: U, netUnits: '1000000', blockHeight: 5257129 });
  });

  it('rejects a tx that failed script validation', async () => {
    await expect(verifyCollection({ txHash: HASH, sellerAddress: SELLER, unit: U, blockfrostKey: 'k', fetchImpl: blockfrost({ block_height: 1, valid_contract: false }, collection) })).rejects.toThrow(/script validation/);
  });

  it('rejects a tx that does not pay the seller', async () => {
    await expect(verifyCollection({ txHash: HASH, sellerAddress: 'addr_test1qother', unit: U, blockfrostKey: 'k', fetchImpl: blockfrost({ block_height: 1, valid_contract: true }, collection) })).rejects.toThrow(/does not pay/);
  });

  it('rejects a mismatched tx hash from the API', async () => {
    await expect(verifyCollection({ txHash: HASH, sellerAddress: SELLER, unit: U, blockfrostKey: 'k', fetchImpl: blockfrost({ block_height: 1, valid_contract: true }, { ...collection, hash: 'ff'.repeat(32) }) })).rejects.toThrow(/different transaction/);
  });

  it('rejects a malformed tx hash before any request', async () => {
    await expect(verifyCollection({ txHash: 'abc', sellerAddress: SELLER, unit: U, blockfrostKey: 'k' })).rejects.toThrow(/64/);
  });
});
