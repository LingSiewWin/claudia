import { describe, expect, it } from 'vitest';
import { TEST_USDM_UNIT } from '../src/mps';
import { CollectionError, sellerNetUnits, verifyCollection, type TxUtxos } from '../src/settlement';

const U = TEST_USDM_UNIT;
const SELLER = 'addr_test1qrdjlmxk80n3hx32dwu2cf298t05vp47t5ekrcdr7ca8ywct5efu6vn2wj78hqepnzj66heq56lyfkmvhjehx43psprqylpzyl';
const ESCROW = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';
const HASH = '64a9b1a031d220fb48653171fe8989d722ad25c05c8c5e26287ca15e0fa08bed';
const LOCK_TX = 'f0882896c4a8a3ea223c0ffd35ea58a3793a9e19e32cb858b9eb16a696cf5664';
const SUBMIT_TX = 'e03dd2f38aadc13b0bce51e9ca05e51ce59d4e4c1767cce9219b8acfdca1e91a';
const COLLATERAL_TX = '8a354c6c7a2e117b88de2b0c9665201a7cee205eb6b3fe2cfc1a47746abd649f';
const OTHER_TX = '11'.repeat(32);
const VKEY_NFT = '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b10d7fb0f14970d4779d0bb4fdda68aa0e72fdc3ab5a0fc11d130376dcd000000';
const coins = (lovelace: string, usdm?: string) => [{ unit: 'lovelace', quantity: lovelace }, ...(usdm ? [{ unit: U, quantity: usdm }] : [])];
const nft = (lovelace: string) => [{ unit: 'lovelace', quantity: lovelace }, { unit: VKEY_NFT, quantity: '1' }];

// The reference seller collection 64a9b1a0... on preprod, transcribed from chain data. It spends the escrow output
// that the seller's submit-result tx e03dd2f3... recreated (the buyer's lock was f0882896...), and pays the seller 1 tUSDM.
const collection: TxUtxos = {
  hash: HASH,
  inputs: [
    { address: SELLER, tx_hash: SUBMIT_TX, amount: nft('4255598'), collateral: false, reference: false },
    { address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950', '1000000'), collateral: false, reference: false },
    { address: SELLER, tx_hash: COLLATERAL_TX, amount: coins('5000000'), collateral: true, reference: false },
  ],
  outputs: [
    { address: SELLER, amount: coins('1383510', '1000000'), collateral: false },
    { address: 'addr_test1qz2aac04ekm83yyy6d0wwah870939s52a3d704saq7fqagm606t6gx6v3cg7sy9g652dvg2v5qf3mdmz0d9vl77shr6s0h5dsg', amount: coins('4469470'), collateral: false },
    { address: SELLER, amount: nft('2232513'), collateral: false },
    { address: SELLER, amount: coins('2000000'), collateral: true },
  ],
};

describe('sellerNetUnits', () => {
  it('measures the escrowed tUSDM reaching the seller', () => {
    expect(sellerNetUnits(collection, SELLER, U)).toBe(1_000_000n);
  });

  it('seller change does not inflate the receipt', () => {
    const tx: TxUtxos = {
      hash: HASH,
      inputs: [{ address: SELLER, tx_hash: OTHER_TX, amount: coins('2000000', '100') }],
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
  const TX_INFO = { hash: HASH, block_height: 5257129, valid_contract: true };
  const blockfrost = (tx: unknown, utxos: unknown) =>
    (async (url: string | URL | Request) =>
      new Response(JSON.stringify(String(url).endsWith('/utxos') ? utxos : tx), { status: 200 })) as typeof fetch;
  const args = (fetchImpl?: typeof fetch) => ({
    txHash: HASH,
    sellerAddress: SELLER,
    escrowAddress: ESCROW,
    unit: U,
    minUnits: 1_000_000n,
    paymentTxHashes: [LOCK_TX, SUBMIT_TX],
    blockfrostKey: 'k',
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it('returns the proof for the reference collection tx', async () => {
    const proof = await verifyCollection(args(blockfrost(TX_INFO, collection)));
    expect(proof).toEqual({ txHash: HASH, explorer: `https://preprod.cardanoscan.io/transaction/${HASH}`, sellerAddress: SELLER, unit: U, netUnits: '1000000', blockHeight: 5257129 });
  });

  it('asks Blockfrost preprod with the project key and refuses redirects', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(String(url).endsWith('/utxos') ? collection : TX_INFO), { status: 200 });
    }) as typeof fetch;
    await verifyCollection(args(fetchImpl));
    expect(seen.map((s) => s.url)).toEqual([
      `https://cardano-preprod.blockfrost.io/api/v0/txs/${HASH}`,
      `https://cardano-preprod.blockfrost.io/api/v0/txs/${HASH}/utxos`,
    ]);
    for (const { init } of seen) {
      expect(new Headers(init.headers).get('project_id')).toBe('k');
      expect(init.redirect).toBe('error');
    }
  });

  it('accepts a batched collection that also pays out other payments', async () => {
    const batch: TxUtxos = {
      hash: HASH,
      inputs: [
        { address: ESCROW, tx_hash: OTHER_TX, amount: coins('2000000', '1000000') },
        { address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950', '1000000') },
        { address: ESCROW, tx_hash: '22'.repeat(32), amount: coins('2000000', '2000000') },
        { address: SELLER, tx_hash: COLLATERAL_TX, amount: coins('5000000'), collateral: true },
      ],
      outputs: [{ address: SELLER, amount: coins('8000000', '4000000') }],
    };
    const proof = await verifyCollection(args(blockfrost(TX_INFO, batch)));
    expect(proof.netUnits).toBe('4000000');
  });

  it.each<[string, TxUtxos, RegExp]>([
    [
      'an unrelated 1-unit transfer to the seller',
      { hash: HASH, inputs: [{ address: 'addr_test1qbuyer', tx_hash: OTHER_TX, amount: coins('3000000', '1') }], outputs: [{ address: SELLER, amount: coins('1500000', '1') }] },
      /no escrow input/,
    ],
    [
      'a full-price transfer to the seller with no escrow input',
      { hash: HASH, inputs: [{ address: 'addr_test1qbuyer', tx_hash: SUBMIT_TX, amount: coins('3000000', '1000000') }], outputs: [{ address: SELLER, amount: coins('1500000', '1000000') }] },
      /no escrow input/,
    ],
    [
      'an escrow input without the unit',
      { hash: HASH, inputs: [{ address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950') }, { address: 'addr_test1qbuyer', tx_hash: OTHER_TX, amount: coins('3000000', '1000000') }], outputs: [{ address: SELLER, amount: coins('1500000', '1000000') }] },
      /no escrow input/,
    ],
    [
      'an escrow output that is only referenced, not spent',
      { hash: HASH, inputs: [{ address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950', '1000000'), reference: true }, { address: 'addr_test1qbuyer', tx_hash: OTHER_TX, amount: coins('3000000', '1000000') }], outputs: [{ address: SELLER, amount: coins('1500000', '1000000') }] },
      /no escrow input/,
    ],
    [
      "another payment's escrow output",
      { hash: HASH, inputs: [{ address: ESCROW, tx_hash: OTHER_TX, amount: coins('4503950', '1000000') }], outputs: [{ address: SELLER, amount: coins('1500000', '1000000') }] },
      /this payment/,
    ],
    [
      'less than the price to the seller',
      { hash: HASH, inputs: [{ address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950', '1000000') }], outputs: [{ address: SELLER, amount: coins('1500000', '999999') }, { address: 'addr_test1qbuyer', amount: coins('2000000', '1') }] },
      /does not pay/,
    ],
  ])('rejects %s with a CollectionError', async (_label, utxos, message) => {
    const e = await failure(verifyCollection(args(blockfrost(TX_INFO, utxos))));
    expect(e).toBeInstanceOf(CollectionError);
    expect(e).toHaveProperty('message', expect.stringMatching(message));
  });

  it('rejects the reference tx checked against a different escrow address', async () => {
    const e = await failure(verifyCollection({ ...args(blockfrost(TX_INFO, collection)), escrowAddress: 'addr_test1wzother' }));
    expect(e).toBeInstanceOf(CollectionError);
    expect(e).toHaveProperty('message', expect.stringMatching(/no escrow input/));
  });

  it('rejects the reference tx when its escrow output is not one of the payment transactions', async () => {
    const e = await failure(verifyCollection({ ...args(blockfrost(TX_INFO, collection)), paymentTxHashes: [LOCK_TX] }));
    expect(e).toBeInstanceOf(CollectionError);
    expect(e).toHaveProperty('message', expect.stringMatching(/this payment/));
  });

  it('rejects a tx that failed script validation', async () => {
    const e = await failure(verifyCollection(args(blockfrost({ ...TX_INFO, valid_contract: false }, collection))));
    expect(e).toBeInstanceOf(CollectionError);
    expect(e).toHaveProperty('message', expect.stringMatching(/script validation/));
  });

  it('rejects a tx that does not pay the seller', async () => {
    const e = await failure(verifyCollection({ ...args(blockfrost(TX_INFO, collection)), sellerAddress: 'addr_test1qother' }));
    expect(e).toBeInstanceOf(CollectionError);
    expect(e).toHaveProperty('message', expect.stringMatching(/does not pay/));
  });

  it('refuses a non-positive floor', async () => {
    await expect(verifyCollection({ ...args(blockfrost(TX_INFO, collection)), minUnits: 0n })).rejects.toThrow(TypeError);
  });

  it.each<[string, unknown, unknown]>([
    ['/txs', { ...TX_INFO, hash: 'ff'.repeat(32) }, collection],
    ['/txs/{hash}/utxos', TX_INFO, { ...collection, hash: 'ff'.repeat(32) }],
  ])('rejects a different transaction from %s as a plain Error', async (_label, tx, utxos) => {
    const e = await failure(verifyCollection(args(blockfrost(tx, utxos))));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CollectionError);
    expect(e).toHaveProperty('message', expect.stringMatching(/different transaction/));
  });

  it.each([404, 429, 500])('reports Blockfrost HTTP %i as a plain Error', async (status) => {
    const e = await failure(verifyCollection(args((async () => new Response('{}', { status })) as typeof fetch)));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CollectionError);
    expect(e).toHaveProperty('message', `Blockfrost /txs/${HASH} HTTP ${status}`);
  });

  it('rejects a malformed tx hash before any request', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return new Response('{}');
    }) as typeof fetch;
    const e = await failure(verifyCollection({ ...args(fetchImpl), txHash: 'abc' }));
    expect(e).toBeInstanceOf(CollectionError);
    expect(e).toHaveProperty('message', expect.stringMatching(/64/));
    expect(requests).toBe(0);
  });
});
