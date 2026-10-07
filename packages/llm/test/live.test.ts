import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { converse, modelFromEnv, type ToolHandler } from '../src';

// Real provider round trip (tool call, tool result, final answer). Runs only with LLM_LIVE=1 (it then loads the
// repo-root .env); each provider runs only when its credentials are present. Prints model ids, never keys.
const live = process.env.LLM_LIVE === '1';
const envFile = new URL('../../../.env', import.meta.url);
if (live && existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const providers = [
  { provider: 'anthropic', ready: Boolean(env.ANTHROPIC_API_KEY) },
  { provider: 'bedrock', ready: Boolean(env.AWS_REGION && (env.AWS_ACCESS_KEY_ID || env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_PROFILE)) },
];

describe.skipIf(!live).each(providers)('live $provider', ({ provider, ready }) => {
  it.skipIf(!ready)('calls a tool and answers from its result', async () => {
    const model = modelFromEnv({ ...env, AGENT_MODEL_PROVIDER: provider });
    const lookup: ToolHandler = {
      def: {
        name: 'get_invoice',
        description: 'Read one open invoice by number. Read-only.',
        input_schema: { type: 'object', properties: { invoice_number: { type: 'string' } }, required: ['invoice_number'], additionalProperties: false },
      },
      effect: 'read',
      handle: async () => JSON.stringify({ invoice_number: 'INV-3821', amount_due_usdm: '8.42' }),
    };
    const stops: string[] = [];
    const c = await converse({
      model,
      system: 'You are a test agent. Use the tool, then answer in one sentence.',
      prompt: 'What is the amount due on invoice INV-3821?',
      tools: [lookup],
      maxTurns: 4,
      onEvent: (e) => void (e.type === 'turn' && stops.push(`${e.stop}:${e.tools.join(',')}`)),
    });
    console.log(JSON.stringify({ provider, model: c.turns[0]!.model, stops, answer: c.finalText }));
    expect(stops[0]).toBe('tool_use:get_invoice');
    expect(c.stop).toBe('end_turn');
    expect(c.finalText).toContain('8.42');
  }, 120_000);
});
