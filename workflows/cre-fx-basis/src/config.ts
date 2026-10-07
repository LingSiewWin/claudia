import * as z from 'zod';

const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((a) => !/^0x0{40}$/.test(a), 'zero address');

// The feed lives on Ethereum mainnet (BRL/USD, brl-usd.data.eth); reports are written to Sepolia.
const feed = { feedChainSelectorName: z.literal('ethereum-mainnet'), feedAddress: evmAddress };

export const configSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('local-simulation'), ...feed }),
  z.strictObject({
    mode: z.literal('sepolia'),
    ...feed,
    chainSelectorName: z.literal('ethereum-testnet-sepolia'),
    registryAddress: evmAddress,
    gasLimit: z.string().regex(/^[1-9][0-9]{0,8}$/),
  }),
]);
export type Config = z.infer<typeof configSchema>;
