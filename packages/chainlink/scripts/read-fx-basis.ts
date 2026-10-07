// Reads an fx-basis report back from the Sepolia FxBasisRegistry and hash-checks it.
// Usage: pnpm --filter @authority/chainlink read-fx-basis <registry> <report_hash>
import { resolve } from 'node:path';
import { createPublicClient, getAddress, http } from 'viem';
import { sepolia } from 'viem/chains';
import { readFxBasis } from '../src/fx-reader';

process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
const [registry, reportHash] = process.argv.slice(2);
if (!registry || !reportHash) throw new Error('usage: read-fx-basis <registry> <report_hash>');
const rpc = process.env.SEPOLIA_RPC_URL;
if (!rpc) throw new Error('SEPOLIA_RPC_URL is not set in .env');

const client = createPublicClient({ chain: sepolia, transport: http(rpc) });
console.log(JSON.stringify(await readFxBasis(client, getAddress(registry), reportHash), null, 2));
