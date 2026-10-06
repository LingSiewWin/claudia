// Public values only. Every value here is inlined into the browser bundle at build time.
export const config = {
  apiBase: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8787',
  koiosBase: process.env.NEXT_PUBLIC_KOIOS_URL ?? '/api/koios',
  sepoliaRpc: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
  registryAddress: (process.env.NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS ?? '').toLowerCase(),
  stageMandateId: process.env.NEXT_PUBLIC_STAGE_MANDATE_ID ?? 'M-001',
};

export const cardanoTxUrl = (hash: string) => `https://preprod.cexplorer.io/tx/${hash}`;
export const sepoliaTxUrl = (hash: string) => `https://sepolia.etherscan.io/tx/${hash.startsWith('0x') ? hash : `0x${hash}`}`;

/** Where browser Verify reads chain data from, shown next to every result. NEXT_PUBLIC_KOIOS_URL switches Koios to direct. */
export const dataSource = {
  cardano: config.koiosBase.startsWith('/') ? 'Koios (relayed through Vercel)' : `Koios (direct, ${new URL(config.koiosBase).host})`,
  sepolia: `Sepolia public RPC (direct, ${new URL(config.sepoliaRpc).host})`,
};
