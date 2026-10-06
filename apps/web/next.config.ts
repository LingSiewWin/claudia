import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Vercel builds must point at the real Authority API and registry; never at the local fixture server.
if (process.env.VERCEL === '1') {
  const api = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
  const registry = process.env.NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS ?? '';
  if (!api.startsWith('https://')) throw new Error('NEXT_PUBLIC_API_BASE_URL must be the https Authority API URL');
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) throw new Error('NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS must be set');
}

const nextConfig: NextConfig = {
  // packages/core ships TypeScript source (exports ./src/index.ts); the same code runs in the browser.
  transpilePackages: ['@authority/core'],
  // Pin the workspace root so Turbopack never walks above the repository looking for lockfiles.
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
};

export default nextConfig;
