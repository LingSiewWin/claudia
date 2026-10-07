import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// A Vercel build with an Authority API configured must point at the public https API and the real registry,
// never at the local fixture server. With no API configured the site runs in fixture mode (lib/config.ts).
if (process.env.VERCEL === '1' && process.env.NEXT_PUBLIC_API_BASE_URL) {
  const api = process.env.NEXT_PUBLIC_API_BASE_URL;
  const registry = process.env.NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS ?? '';
  const https = (v: string) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  };
  const host = (v: string) => {
    try {
      return new URL(v).hostname;
    } catch {
      return '';
    }
  };
  const local = (h: string) => /^(localhost|.*\.localhost)\.?$/i.test(h) || h === '[::1]' || h === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(h);
  if (!https(api) || local(host(api))) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL must be the public https Authority API URL, not localhost');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) throw new Error('NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS must be set');
  if (registry.toLowerCase() === `0x${'5e'.repeat(20)}`) throw new Error('NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS is the fixture address');
  const koios = process.env.NEXT_PUBLIC_KOIOS_URL;
  if (koios && !https(koios)) throw new Error('NEXT_PUBLIC_KOIOS_URL must be an https URL when set');
  const sepolia = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  if (sepolia && !https(sepolia)) throw new Error('NEXT_PUBLIC_SEPOLIA_RPC_URL must be an https URL');
}

const nextConfig: NextConfig = {
  // packages/core ships TypeScript source (exports ./src/index.ts); the same code runs in the browser.
  transpilePackages: ['@authority/core'],
  // Pin the workspace root so Turbopack never walks above the repository looking for lockfiles.
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
  // /protocol.md is the Markdown route; the folder is named protocol-md because *.md paths are local-only in this repo.
  rewrites: async () => [{ source: '/protocol.md', destination: '/protocol-md' }],
};

export default nextConfig;
