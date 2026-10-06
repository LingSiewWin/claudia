import { blake2b256, bytesToHex, hexToBytes } from '@authority/core';
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

// Inline datum of the reference escrow output e03dd2f3...#0, the payment contract's 19-field Constr 0. Field 10 is the
// purchase inputHash (INPUT_HASH); field 4 holds the buyer's COSE key, itself a 32-byte bytes item (BUYER_KEY).
const INPUT_HASH = '41d4e66c2760c8aeb4b7b417553899167ea45409ee7ec44b1fae6f59d80a3770';
const BUYER_KEY = '18b36a4a09d20f1c27c1f3650b1eb49b6d2b31ffb9a6f9fd2b5735a6f1f6c6c4';
const DATUM = [
  'd8799fd8799fd8799f581c95dee1f5cdb6789084d35ee776e7f3cb12c28aec5be7d61d07920ea3ffd8799fd8799fd8799f581c7a7e97a4',
  '1b4c8e11e810a8d514d6214ca0131db7627b4acffbd0b8f5ffffffffd87a80d8799fd8799f581cdb2fecd63be71b9a2a6bb8ac25453adf',
  '4606be5d3361e1a3f63a723bffd8799fd8799fd8799f581c0ba653cd326a74bc7b832198a5ad5f20a6be44db6cbcb37356218046ffffff',
  'ffd87a80582aa401010327200621582018b36a4a09d20f1c27c1f3650b1eb49b6d2b31ffb9a6f9fd2b5735a6f1f6c6c45f5840845869a3',
  '012704582018b36a4a09d20f1c27c1f3650b1eb49b6d2b31ffb9a6f9fd2b5735a6f1f6c6c46761646472657373583900db2fecd63be71b',
  '9a2a6bb8ac584025453adf4606be5d3361e1a3f63a723b0ba653cd326a74bc7b832198a5ad5f20a6be44db6cbcb37356218046a1666861',
  '73686564f458206d2e445949faf15f025840e7ac93d8f9b53fba8afa9053ff2f630f7a19e26f1e565e5840679db162b82951f760a099b9',
  '2c2c8e5defd3821548ce80fe14c2bf377c9d575820a7437614aaa05819e16283615ade335ee64ec85c0cb8e2620bfc892983d2bf6f03ff',
  '582055a3836c0b11b5bf1a15c033d299f3461b8451616d5736fbca67390ec5b041be4a57125e6c5a24c5aba1ee583c67ab0c92c4ac1610',
  '895a1c965ee50aba41a8f1513b15240723b3bd0b10d7fb0f14970d4779d0bb4fdda68aa0e72fdc3ab5a0fc11d130376dcd0000001a0044',
  '32de582041d4e66c2760c8aeb4b7b417553899167ea45409ee7ec44b1fae6f59d80a37705820b3ce2f88b138c260700b2f06939e62318a',
  '5840fe20baf4ac18553f67ab1b85c01b000001a10c9afe951b000001a10c9f92751b000001a10cae38751b000001a10cbcde751b000001',
  'a10c9e37d000d87a80ff',
].join('');
// The same escrow datum for another purchase: only field 10 differs.
const datumFor = (inputHash: string) => DATUM.replace(`5820${INPUT_HASH}`, `5820${inputHash}`);
const OTHER_INPUT_HASH = 'be'.repeat(32);

// The reference seller collection 64a9b1a0... on preprod, transcribed from chain data. It spends the escrow output
// that the seller's submit-result tx e03dd2f3... recreated (the buyer's lock was f0882896...), and pays the seller 1 tUSDM.
const collection: TxUtxos = {
  hash: HASH,
  inputs: [
    { address: SELLER, tx_hash: SUBMIT_TX, amount: nft('4255598'), collateral: false, reference: false },
    { address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950', '1000000'), collateral: false, reference: false, inline_datum: DATUM },
    { address: SELLER, tx_hash: COLLATERAL_TX, amount: coins('5000000'), collateral: true, reference: false },
  ],
  outputs: [
    { address: SELLER, amount: coins('1383510', '1000000'), collateral: false },
    { address: 'addr_test1qz2aac04ekm83yyy6d0wwah870939s52a3d704saq7fqagm606t6gx6v3cg7sy9g652dvg2v5qf3mdmz0d9vl77shr6s0h5dsg', amount: coins('4469470'), collateral: false },
    { address: SELLER, amount: nft('2232513'), collateral: false },
    { address: SELLER, amount: coins('2000000'), collateral: true },
  ],
};

describe('reference escrow datum', () => {
  it('is the on-chain datum (blake2b-256 equals the datum hash Blockfrost and Koios report)', () => {
    expect(bytesToHex(blake2b256(hexToBytes(DATUM)))).toBe('6ebd2d83e6e13a7f79f091c272d48939125152bccbd0368dc8cc27ccdd16e41b');
    expect(DATUM.split(`5820${INPUT_HASH}`)).toHaveLength(2);
  });
});

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
    inputHash: INPUT_HASH,
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
        { address: ESCROW, tx_hash: OTHER_TX, amount: coins('2000000', '1000000'), inline_datum: datumFor('c1'.repeat(32)) },
        { address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950', '1000000'), inline_datum: DATUM },
        { address: ESCROW, tx_hash: '22'.repeat(32), amount: coins('2000000', '2000000'), inline_datum: datumFor('c2'.repeat(32)) },
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
      { hash: HASH, inputs: [{ address: ESCROW, tx_hash: OTHER_TX, amount: coins('4503950', '1000000'), inline_datum: DATUM }], outputs: [{ address: SELLER, amount: coins('1500000', '1000000') }] },
      /created by this payment's transactions/,
    ],
    [
      'less than the price to the seller',
      { hash: HASH, inputs: [{ address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950', '1000000'), inline_datum: DATUM }], outputs: [{ address: SELLER, amount: coins('1500000', '999999') }, { address: 'addr_test1qbuyer', amount: coins('2000000', '1') }] },
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
    expect(e).toHaveProperty('message', expect.stringMatching(/created by this payment's transactions/));
  });

  // The payment service batches result submissions: one submit tx recreates the escrow of purchases A and B.
  describe('escrow outputs from a batched result submission', () => {
    const escrowA = { address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950', '1000000'), inline_datum: DATUM };
    const escrowB = { address: ESCROW, tx_hash: SUBMIT_TX, amount: coins('4503950', '1000000'), inline_datum: datumFor(OTHER_INPUT_HASH) };
    const collect = (...escrows: TxUtxos['inputs']): TxUtxos => ({
      hash: HASH,
      inputs: escrows,
      outputs: [{ address: SELLER, amount: coins('2000000', String(1_000_000 * escrows.length)) }],
    });

    it("rejects a collection of only B's escrow as proof for A", async () => {
      const e = await failure(verifyCollection(args(blockfrost(TX_INFO, collect(escrowB)))));
      expect(e).toBeInstanceOf(CollectionError);
      expect(e).toHaveProperty('message', expect.stringMatching(/inputHash/));
    });

    it("accepts A's own escrow, alone or collected together with B's", async () => {
      await expect(verifyCollection(args(blockfrost(TX_INFO, collect(escrowA))))).resolves.toMatchObject({ netUnits: '1000000' });
      await expect(verifyCollection(args(blockfrost(TX_INFO, collect(escrowB, escrowA))))).resolves.toMatchObject({ netUnits: '2000000' });
      await expect(verifyCollection({ ...args(blockfrost(TX_INFO, collect(escrowA, escrowB))), inputHash: OTHER_INPUT_HASH })).resolves.toMatchObject({ netUnits: '2000000' });
    });

    it("checks field 10 exactly: A's inputHash in B's buyer key field does not count", async () => {
      const lookalike = datumFor(OTHER_INPUT_HASH).replaceAll(`5820${BUYER_KEY}`, `5820${INPUT_HASH}`);
      expect(lookalike.includes(`5820${INPUT_HASH}`)).toBe(true);
      const e = await failure(verifyCollection(args(blockfrost(TX_INFO, collect({ ...escrowB, inline_datum: lookalike })))));
      expect(e).toBeInstanceOf(CollectionError);
      expect(e).toHaveProperty('message', expect.stringMatching(/inputHash/));
    });

    it('reads the fields of a definite-length Constr 0 encoding too', async () => {
      const definite = `d87993${DATUM.slice(6, -2)}`;
      await expect(verifyCollection(args(blockfrost(TX_INFO, collect({ ...escrowA, inline_datum: definite }))))).resolves.toMatchObject({ netUnits: '1000000' });
    });

    it.each<[string, string | null]>([
      ['no inline datum', null],
      ['a truncated datum', DATUM.slice(0, -2)],
      ['trailing bytes', `${DATUM}00`],
      ['Constr 1 instead of Constr 0', `d87a${DATUM.slice(4)}`],
      ['18 fields', `${DATUM.slice(0, -8)}ff`],
      ['field 10 as chunked bytes', DATUM.replace(`5820${INPUT_HASH}`, `5f5820${INPUT_HASH}ff`)],
      ['not hex', 'zz'],
    ])('rejects an escrow input with %s', async (_label, inline_datum) => {
      const e = await failure(verifyCollection(args(blockfrost(TX_INFO, collect({ ...escrowA, inline_datum })))));
      expect(e).toBeInstanceOf(CollectionError);
      expect(e).toHaveProperty('message', expect.stringMatching(/inputHash/));
    });
  });

  it('refuses a malformed inputHash argument', async () => {
    await expect(verifyCollection({ ...args(blockfrost(TX_INFO, collection)), inputHash: INPUT_HASH.toUpperCase() })).rejects.toThrow(TypeError);
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
