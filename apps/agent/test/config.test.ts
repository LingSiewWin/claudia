import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const env = {
  AUTHORITY_API_URL: 'https://api.example.test/',
  AUTHORITY_AGENT_KEY: 'agent-key-0123456789abcdef0123456789',
  M001_AGENT_SECRET_KEY: '02'.repeat(32),
  STRIPE_READ_KEY: 'rk_test_x',
  STRIPE_ACME_CUSTOMER_ID: 'cus_X',
};

describe('loadConfig', () => {
  it('reads keys per mandate and defaults the timings', () => {
    const c = loadConfig(env);
    expect([c.apiUrl, [...c.agentKeys.keys()], c.pollMs, c.resolveTimeoutMs, c.maxTurns]).toEqual(['https://api.example.test', ['M-001'], 3000, 900000, 12]);
  });
  it('fails closed', () => {
    expect(() => loadConfig({ ...env, AUTHORITY_AGENT_KEY: 'short' })).toThrow('at least 32 characters');
    expect(() => loadConfig({ ...env, M001_AGENT_SECRET_KEY: '' })).toThrow('set at least one of');
    expect(() => loadConfig({ ...env, M001_AGENT_SECRET_KEY: 'zz' })).toThrow('M001_AGENT_SECRET_KEY');
    expect(() => loadConfig({ ...env, AGENT_POLL_MS: '5' })).toThrow('AGENT_POLL_MS must be an integer >= 250');
  });
});
