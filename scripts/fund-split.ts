// Splits preprod test funds from FEE_WALLET to the other test wallets. Usage: pnpm --filter @authority/scripts fund
// Mnemonics come from ../.env and are never printed. Amounts are in base units (lovelace, tUSDM has 6 decimals).
import { MeshTxBuilder } from '@meshsdk/core';
import { PREPROD_USDM, awaitTx, connect, submit, walletFromMnemonic } from '@authority/cardano';

process.loadEnvFile(new URL('../.env', import.meta.url));
const USDM = PREPROD_USDM.policy + PREPROD_USDM.name;
const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
const fee = await walletFromMnemonic(chain, process.env.FEE_WALLET_MNEMONIC, 'FEE_WALLET_MNEMONIC');
const addr = async (name: string) => (await walletFromMnemonic(chain, process.env[name], name)).address;

const outs: { to: string; label: string; lovelace: bigint; usdm: bigint }[] = [
  { label: 'CFO_TEST', to: await addr('CFO_TEST_MNEMONIC'), lovelace: 300_000_000n, usdm: 100_000_000n },
  { label: 'AGENT_WALLET', to: await addr('AGENT_WALLET_MNEMONIC'), lovelace: 300_000_000n, usdm: 0n },
  { label: 'M_LAB_PRINCIPAL', to: await addr('M_LAB_PRINCIPAL_MNEMONIC'), lovelace: 150_000_000n, usdm: 0n },
  { label: 'M_LAB_APPROVER', to: await addr('M_LAB_APPROVER_MNEMONIC'), lovelace: 100_000_000n, usdm: 0n },
  { label: 'MASUMI_SELLER', to: process.argv[2] ?? '', lovelace: 60_000_000n, usdm: 50_000_000n },
].filter((o) => o.to !== '');

const { utxos } = await fee.snapshot();
const tx = new MeshTxBuilder({ params: chain.params, fetcher: chain.provider });
for (const o of outs) {
  const amount = [{ unit: 'lovelace', quantity: o.lovelace.toString() }];
  if (o.usdm > 0n) amount.push({ unit: USDM, quantity: o.usdm.toString() });
  tx.txOut(o.to, amount);
  console.log(`${o.label.padEnd(16)} ${o.to}  ${Number(o.lovelace) / 1e6} tADA${o.usdm > 0n ? ` + ${Number(o.usdm) / 1e6} tUSDM` : ''}`);
}
const unsigned = await tx.changeAddress(fee.address).selectUtxosFrom(utxos).complete();
const hash = await submit(chain, await fee.sign(unsigned));
console.log(`\nsubmitted ${hash}\nhttps://preprod.cardanoscan.io/transaction/${hash}`);
await awaitTx(chain, hash);
console.log('confirmed');
