// Resets the M-LAB vault to 10.00 USDM with a fresh daily window (principal-signed). Usage: pnpm --filter @authority/scripts lab:reset
import { awaitIndexed, awaitTx, buildTx, connect, deployment, planVaultReset, readAnchor, readRefScript, readVault, signAndSubmit, walletFromMnemonic } from '@authority/cardano';

process.loadEnvFile(new URL('../.env', import.meta.url));
const chain = await connect(process.env.BLOCKFROST_PROJECT_ID_PREPROD);
const lab = deployment('M-LAB');
const principal = await walletFromMnemonic(chain, process.env.M_LAB_PRINCIPAL_MNEMONIC, 'M_LAB_PRINCIPAL_MNEMONIC');
const [anchor, vault, refScript] = await Promise.all([readAnchor(chain.provider, lab), readVault(chain.provider, lab), readRefScript(chain.provider, lab)]);
console.log(`before: balance ${vault.balance} spent_today ${vault.datum.spent_today} day_index ${vault.datum.day_index} last_nonce ${vault.datum.last_nonce}`);
const plan = planVaultReset(lab, anchor, vault, refScript, await principal.snapshot(), 10_000_000n);
const hash = await signAndSubmit(chain, await buildTx(chain, plan), [principal]);
await awaitTx(chain, hash);
await awaitIndexed(chain, lab.vault.address, hash);
const after = await readVault(chain.provider, lab);
console.log(`reset ${hash}\nhttps://preprod.cardanoscan.io/transaction/${hash}\nafter: balance ${after.balance} spent_today ${after.datum.spent_today} day_index ${after.datum.day_index}`);
