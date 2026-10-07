// Gives a test wallet a second ADA-only UTxO (collateral for script transactions). Usage: pnpm --filter @authority/scripts split-self <ENV_NAME> [lovelace]
import { MeshTxBuilder } from '@meshsdk/core';
import { awaitTx, connect, submit, walletFromMnemonic } from '@authority/cardano';

process.loadEnvFile(new URL('../.env', import.meta.url));
const name = process.argv[2];
if (!name) throw new Error('usage: split-self <ENV_NAME> [lovelace]');
const amount = process.argv[3] ?? '20000000';
const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
const w = await walletFromMnemonic(chain, process.env[name], name);
const { utxos } = await w.snapshot();
const unsigned = await new MeshTxBuilder({ params: chain.params, fetcher: chain.provider })
  .txOut(w.address, [{ unit: 'lovelace', quantity: amount }])
  .changeAddress(w.address)
  .selectUtxosFrom(utxos)
  .complete();
const hash = await submit(chain, await w.sign(unsigned));
console.log(`${name} ${w.address} +1 utxo of ${Number(amount) / 1e6} tADA: https://preprod.cardanoscan.io/transaction/${hash}`);
await awaitTx(chain, hash);
console.log('confirmed');
