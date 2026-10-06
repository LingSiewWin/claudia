import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config defaults', () => {
  it('treats empty NEXT_PUBLIC_* values as unset', async () => {
    for (const k of ['API_BASE_URL', 'KOIOS_URL', 'SEPOLIA_RPC_URL', 'STAGE_MANDATE_ID']) vi.stubEnv(`NEXT_PUBLIC_${k}`, '');
    const { config } = await import('../lib/config');
    expect(config.apiBase).toBe('http://localhost:8787');
    expect(config.koiosBase).toBe('/api/koios');
    expect(config.sepoliaRpc).toMatch(/^https:\/\//);
    expect(config.stageMandateId).toBe('M-001');
  });
});
