// Sends preprod test funds from FEE_WALLET. Usage: pnpm --filter @authority/scripts send <address> <lovelace> [tUSDM base units]
import { MeshTxBuilder } from '@meshsdk/core';
import { PREPROD_USDM, awaitTx, connect, submit, walletFromMnemonic } from '@authority/cardano';

process.loadEnvFile(new URL('../.env', import.meta.url));
const [to = "", lovelace = "", usdm = "0"] = process.argv.slice(2);
if (!to.startsWith('addr_test1') || !/^\d+$/.test(lovelace) || !/^\d+$/.test(usdm)) throw new Error('usage: send <addr_test1...> <lovelace> [usdm]');
const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
const fee = await walletFromMnemonic(chain, process.env.FEE_WALLET_MNEMONIC, 'FEE_WALLET_MNEMONIC');
const amount = [{ unit: 'lovelace', quantity: lovelace }];
if (usdm !== '0') amount.push({ unit: PREPROD_USDM.policy + PREPROD_USDM.name, quantity: usdm });
const unsigned = await new MeshTxBuilder({ params: chain.params, fetcher: chain.provider }).txOut(to, amount).changeAddress(fee.address).selectUtxosFrom((await fee.snapshot()).utxos).complete();
const hash = await submit(chain, await fee.sign(unsigned));
console.log(`sent ${Number(lovelace) / 1e6} tADA${usdm !== '0' ? ` + ${Number(usdm) / 1e6} tUSDM` : ''} to ${to}\nhttps://preprod.cardanoscan.io/transaction/${hash}`);
await awaitTx(chain, hash);
console.log('confirmed');
