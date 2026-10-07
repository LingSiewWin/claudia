// Escalation bond on preprod: an agent locks a 5 tADA bond, then the approver's signature refunds it.
// Usage: pnpm --filter @authority/scripts bond [refund | capture]
// Wallets (mnemonics in ../.env, never printed): AGENT_WALLET_MNEMONIC locks the bond, CFO_TEST_MNEMONIC is the
// approver who co-signs the spend, FEE_WALLET_MNEMONIC builds and pays for the spend. The approver receives nothing.
import { type EscalationPrice, canonicalHash } from '@authority/core';
import { type BondOutcome, awaitTx, buildBondSpend, connect, escrowAddress, lockBond, readBond, sinkAddress, submit, walletFromMnemonic } from '@authority/cardano';

process.loadEnvFile(new URL('../.env', import.meta.url));

const outcome = (process.argv[2] ?? 'refund') as BondOutcome;
if (outcome !== 'refund' && outcome !== 'capture') throw new Error('usage: bond [refund | capture]');
const link = (hash: string) => `https://preprod.cardanoscan.io/transaction/${hash}`;

const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
const agent = await walletFromMnemonic(chain, process.env.AGENT_WALLET_MNEMONIC, 'AGENT_WALLET_MNEMONIC');
const approver = await walletFromMnemonic(chain, process.env.CFO_TEST_MNEMONIC, 'CFO_TEST_MNEMONIC');
const fee = await walletFromMnemonic(chain, process.env.FEE_WALLET_MNEMONIC, 'FEE_WALLET_MNEMONIC');
console.log(`escrow   ${escrowAddress(0)}\nsink     ${sinkAddress(0)}\nagent    ${agent.address}\napprover ${approver.pkh} (key hash)\nfee      ${fee.address}`);

const lovelace = async (address: string) =>
  (await chain.provider.fetchAddressUTxOs(address)).reduce((s, u) => s + BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0'), 0n);
for (const [name, w] of [['agent', agent], ['fee', fee]] as const) {
  const have = await lovelace(w.address);
  if (have < 12_000_000n) throw new Error(`${name} wallet ${w.address} holds ${Number(have) / 1e6} tADA; it needs at least 12 (5 bond + fees + 5 ADA collateral). Fund it at https://docs.cardano.org/cardano-testnets/tools/faucet`);
}

const approvalId = `AP-demo-${Date.now()}`;
const price: EscalationPrice = {
  schema: 'escalation-price/v0.1',
  approval_id: approvalId,
  network: 'cardano-preprod',
  asset: { policy_id: '', asset_name: '', symbol: 'ADA' },
  amount: process.env.ESCALATION_BOND_LOVELACE ?? '5000000',
  escrow_address: escrowAddress(0),
  action_hash: canonicalHash({ demo: approvalId }),
  approver_key_hash: approver.pkh,
  locked_until_ms: Date.now() + 3_600_000,
  interrupt_budget: { used: 0, per_day: 3 },
};

const approverBefore = await lovelace(approver.address);
console.log(`\nlocking ${Number(price.amount) / 1e6} tADA for ${approvalId} ...`);
const bond = await lockBond(chain, agent, price);
console.log(`locked   ${bond.tx_hash}#${bond.output_index}\n         ${link(bond.tx_hash)}`);

const seen = await readBond(chain, price);
if (!seen || seen.tx_hash !== bond.tx_hash) throw new Error('readBond did not find the bond that was just locked');
console.log(`readBond ok: datum matches price, amount ${seen.amount} lovelace`);

console.log(`\n${outcome} with the approver's signature ...`);
const unsigned = await buildBondSpend(chain, fee, bond, outcome);
let tx = await fee.sign(unsigned.txCbor);
tx = await approver.sign(tx);
const spent = await submit(chain, tx);
await awaitTx(chain, spent);
console.log(`${outcome.padEnd(8)} ${spent}\n         ${link(spent)}`);
console.log(`\nafter: bond at escrow = ${(await readBond(chain, price)) === null ? 'gone' : 'STILL THERE'}; approver balance unchanged = ${(await lovelace(approver.address)) === approverBefore}`);
