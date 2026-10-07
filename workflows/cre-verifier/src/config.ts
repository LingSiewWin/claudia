// Workflow config and HTTP trigger access. Type-only SDK import, so this runs under vitest.
import type { HTTP_TRIGGER_PB } from '@chainlink/cre-sdk/pb';
import * as z from 'zod';

const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((a) => !/^0x0{40}$/.test(a), 'zero address');

const sepoliaWrite = {
  chainSelectorName: z.literal('ethereum-testnet-sepolia'),
  registryAddress: evmAddress,
  gasLimit: z.string().regex(/^[1-9][0-9]{0,8}$/),
};

// Simulation targets have no trigger keys: the only way to run them is the operator's own
// `cre workflow simulate`. A deployed workflow is reachable over HTTP, so its target must list
// the engine's EVM signing addresses, and the trigger accepts requests signed by those alone.
export const configSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('local-simulation') }),
  z.strictObject({ mode: z.literal('sepolia'), ...sepoliaWrite }),
  z.strictObject({
    mode: z.literal('sepolia-deploy'),
    ...sepoliaWrite,
    authorizedKeys: z.array(evmAddress).min(1).max(16),
  }),
]);
export type Config = z.infer<typeof configSchema>;

export function httpTriggerConfig(config: Config): HTTP_TRIGGER_PB.ConfigJson {
  if (config.mode !== 'sepolia-deploy') return {};
  if (!Array.isArray(config.authorizedKeys) || config.authorizedKeys.length === 0) {
    throw new Error('sepolia-deploy: at least one authorized key is required');
  }
  return {
    authorizedKeys: config.authorizedKeys.map((publicKey) => ({ type: 'KEY_TYPE_ECDSA_EVM', publicKey })),
  };
}
