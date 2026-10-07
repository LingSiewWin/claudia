import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config defaults', () => {
  it('treats empty NEXT_PUBLIC_* values as unset', async () => {
    for (const k of ['API_BASE_URL', 'KOIOS_URL', 'SEPOLIA_RPC_URL', 'STAGE_MANDATE_ID', 'STAGE_RUN_ID']) vi.stubEnv(`NEXT_PUBLIC_${k}`, '');
    const { config } = await import('../lib/config');
    expect(config.apiBase).toBe('http://localhost:8787');
    expect(config.koiosBase).toBe('/api/koios');
    expect(config.sepoliaRpc).toMatch(/^https:\/\//);
    expect(config.stageMandateId).toBe('M-001');
    expect(config.stageRunId).toBe('run-stage-0001');
  });

  it('names the Vercel relay when Koios has no public URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_KOIOS_URL', '');
    const { dataSource } = await import('../lib/config');
    expect(dataSource.cardano).toBe('Koios (relayed through Vercel)');
  });

  it('names the public Koios host when a direct URL is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_KOIOS_URL', 'https://preprod.koios.rest/api/v1');
    const { dataSource } = await import('../lib/config');
    expect(dataSource.cardano).toBe('Koios (direct, preprod.koios.rest)');
  });
});

