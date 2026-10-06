import { describe, expect, it } from 'vitest';
import { type Config, configSchema, httpTriggerConfig } from '../src/config';

const ENGINE_KEY = '0xb08E004bd2b5aFf1F5F950d141f449B1c05800eb';
const sepolia = {
  chainSelectorName: 'ethereum-testnet-sepolia',
  registryAddress: '0xbC0fE56c6F7b42F679A08E0549B14c9dbF69A31B',
  gasLimit: '3000000',
};
const deploy = (authorizedKeys: unknown) => ({ mode: 'sepolia-deploy', ...sepolia, authorizedKeys });

describe('configSchema (deploy targets require engine keys)', () => {
  it('accepts a deploy config with the engine key', () => {
    expect(configSchema.safeParse(deploy([ENGINE_KEY])).success).toBe(true);
  });

  it.each([
    ['an empty key list', deploy([])],
    ['no key list', { mode: 'sepolia-deploy', ...sepolia }],
    ['a zero-address key', deploy(['0x' + '0'.repeat(40)])],
    ['a malformed key', deploy(['0xabc'])],
    ['a non-string key', deploy([{ publicKey: ENGINE_KEY }])],
  ])('refuses a deploy config with %s', (_label, config) => {
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('refuses authorized keys on simulation targets, which only the operator triggers', () => {
    expect(configSchema.safeParse({ mode: 'local-simulation', authorizedKeys: [ENGINE_KEY] }).success).toBe(false);
    expect(configSchema.safeParse({ mode: 'sepolia', ...sepolia, authorizedKeys: [ENGINE_KEY] }).success).toBe(false);
  });
});

describe('httpTriggerConfig', () => {
  it('restricts a deploy target to the configured engine keys', () => {
    const config = configSchema.parse(deploy([ENGINE_KEY]));
    expect(httpTriggerConfig(config)).toEqual({
      authorizedKeys: [{ type: 'KEY_TYPE_ECDSA_EVM', publicKey: ENGINE_KEY }],
    });
  });

  it('fails closed if a deploy config without keys bypasses the schema', () => {
    const config = deploy([]) as unknown as Config;
    expect(() => httpTriggerConfig(config)).toThrow('authorized key');
  });

  it.each([
    configSchema.parse({ mode: 'local-simulation' }),
    configSchema.parse({ mode: 'sepolia', ...sepolia }),
  ])('leaves simulation target $mode open to the operator-run simulate only', (config) => {
    expect(httpTriggerConfig(config)).toEqual({});
  });
});
