// Public values only. Every value here is inlined into the browser bundle at build time.
// Without NEXT_PUBLIC_API_BASE_URL the site runs in fixture mode: every read comes from fixtures/recorded.json
// through app/api/fixture, so the public pages render with no backend and no chain access.
export const FIXTURE_BASE = '/api/fixture';
export const fixtureMode = !process.env.NEXT_PUBLIC_API_BASE_URL;

export const config = {
  apiBase: process.env.NEXT_PUBLIC_API_BASE_URL || FIXTURE_BASE,
  koiosBase: process.env.NEXT_PUBLIC_KOIOS_URL || (fixtureMode ? `${FIXTURE_BASE}/koios` : '/api/koios'),
  sepoliaRpc: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || (fixtureMode ? `${FIXTURE_BASE}/sepolia` : 'https://ethereum-sepolia-rpc.publicnode.com'),
  registryAddress: (process.env.NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS || (fixtureMode ? `0x${'5e'.repeat(20)}` : '')).toLowerCase(),
  stageMandateId: process.env.NEXT_PUBLIC_STAGE_MANDATE_ID || 'M-001',
  /** The recorded run that opens the evidence chain. Only this run is replayed under the genesis rule. */
  stageRunId: process.env.NEXT_PUBLIC_STAGE_RUN_ID || 'run-stage-0001',
  /** Public URL of the Authority API, as agents reach it. Fixture mode has none. */
  publicApiUrl: process.env.NEXT_PUBLIC_API_BASE_URL || null,
  /** This site's own origin for absolute links in agent-readable files; null means "use the request's origin". */
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || null,
};

/** Canonical public origin for metadata and the sitemap, where no request is available. */
export const PUBLIC_SITE_URL = config.siteUrl ?? 'https://claudiahq.vercel.app';

export const cardanoTxUrl = (hash: string) => `https://preprod.cexplorer.io/tx/${hash}`;
/** Bond escrow transactions link to Cardanoscan, which decodes the escrow datum and redeemer. */
export const cardanoscanTxUrl = (hash: string) => `https://preprod.cardanoscan.io/transaction/${hash}`;
export const sepoliaTxUrl = (hash: string) => `https://sepolia.etherscan.io/tx/${hash.startsWith('0x') ? hash : `0x${hash}`}`;

const hostOf = (base: string) => (base.startsWith('/') ? null : new URL(base).host);

/** Where browser Verify reads chain data from, shown next to every result. NEXT_PUBLIC_KOIOS_URL switches Koios to direct. */
export const dataSource = {
  cardano: config.koiosBase.startsWith(FIXTURE_BASE) ? 'Recorded fixture (no chain read)' : hostOf(config.koiosBase) ? `Koios (direct, ${hostOf(config.koiosBase)})` : 'Koios (relayed through Vercel)',
  sepolia: config.sepoliaRpc.startsWith(FIXTURE_BASE) ? 'Recorded fixture (no chain read)' : `Sepolia public RPC (direct, ${hostOf(config.sepoliaRpc)})`,
};
