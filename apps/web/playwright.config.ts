import { defineConfig, devices } from '@playwright/test';

// Default: fixture API (fixtures/server.ts) + a production build of this app.
// E2E_BASE_URL=https://<deployment>: run the @real specs against a deployed app and the real API.
const real = process.env.E2E_BASE_URL;
export const FIXTURE_API = 'http://localhost:8787';
const publicEnv = {
  NEXT_PUBLIC_API_BASE_URL: FIXTURE_API,
  NEXT_PUBLIC_KOIOS_URL: `${FIXTURE_API}/koios`,
  NEXT_PUBLIC_SEPOLIA_RPC_URL: `${FIXTURE_API}/sepolia`,
  NEXT_PUBLIC_VERIFICATION_REGISTRY_ADDRESS: `0x${'5e'.repeat(20)}`,
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: real ?? 'http://localhost:3100', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  grep: real ? /@real/ : /^(?!.*@real)/,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(real
    ? {}
    : {
        webServer: [
          {
            command: 'pnpm fixture-api',
            url: `${FIXTURE_API}/v1/runs?kind=all`,
            reuseExistingServer: false,
            env: { FIXTURE_API_PORT: '8787', FIXTURE_SSE_PACE_MS: '80' },
          },
          {
            command: 'pnpm build && pnpm start -p 3100',
            port: 3100,
            reuseExistingServer: false,
            timeout: 240_000,
            env: publicEnv,
          },
        ],
      }),
});
