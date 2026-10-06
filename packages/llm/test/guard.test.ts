import { describe, expect, it } from 'vitest';
import { findSecret, guardModel, type ModelInput, SecretLeakError, secretsFromEnv } from '../src';
import { say, scriptedModel } from '../src/scripted';

const AGENT_SK = 'ab'.repeat(32);
const env = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-test-0123456789',
  AUTHORITY_AGENT_KEY: 'agent-key-0123456789abcdef0123456789',
  M001_AGENT_SECRET_KEY: AGENT_SK,
  M001_ENGINE_SECRET_KEY: 'cd'.repeat(32),
  STRIPE_READ_KEY: 'rk_test_0123456789abcdef',
  CFO_TEST_MNEMONIC: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
  BLOCKFROST_PROJECT_ID_PREPROD: 'preprod0123456789abcdef',
  DATABASE_URL: 'postgres://u:pw@db.internal:5432/authority',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AGENT_MODEL_PROVIDER: 'anthropic',
  STRIPE_ACME_CUSTOMER_ID: 'cus_TestCustomer01',
  AUTHORITY_API_URL: 'https://api.example.test',
  AWS_REGION: 'us-east-1',
  SHORT_KEY: 'abc',
};
const input = (text: string): ModelInput => ({ system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [] });

describe('secretsFromEnv', () => {
  it('collects every secret-looking variable and nothing public', () => {
    expect(secretsFromEnv(env).map((s) => s.name).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'AUTHORITY_AGENT_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'BLOCKFROST_PROJECT_ID_PREPROD',
      'CFO_TEST_MNEMONIC',
      'DATABASE_URL',
      'M001_AGENT_SECRET_KEY',
      'M001_ENGINE_SECRET_KEY',
      'STRIPE_READ_KEY',
    ]);
  });
});

describe('guardModel (G2: the model never sees a key)', () => {
  it('passes clean requests through and counts them', async () => {
    const inner = scriptedModel(() => say('ok'));
    const guarded = guardModel(inner, secretsFromEnv(env));
    await guarded.run(input('Process INV-3821 for cus_TestCustomer01 via https://api.example.test'));
    expect(inner.inputs).toHaveLength(1);
    expect(guarded.scanned()).toBe(1);
  });

  it.each([
    ['agent secret key in a tool result', AGENT_SK],
    ['agent secret key upper-cased', AGENT_SK.toUpperCase()],
    ['engine key', 'cd'.repeat(32)],
    ['Stripe read key', 'rk_test_0123456789abcdef'],
    ['API key for the Authority API', 'agent-key-0123456789abcdef0123456789'],
    ['mnemonic', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'],
  ])('refuses a request carrying the %s, and the model never receives it', async (_label, secret) => {
    const inner = scriptedModel(() => say('ok'));
    const guarded = guardModel(inner, secretsFromEnv(env));
    const leaky: ModelInput = {
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_mandate', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ note: `x${secret}y` }), is_error: false }] },
      ],
      tools: [],
    };
    const error = await guarded.run(leaky).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretLeakError);
    expect((error as Error).message).not.toContain(secret);
    expect(inner.inputs).toHaveLength(0);
  });

  it('also scans tool definitions and the system prompt', () => {
    const secrets = secretsFromEnv(env);
    expect(findSecret({ system: `key ${env.STRIPE_READ_KEY}`, messages: [], tools: [] }, secrets)).toBe('STRIPE_READ_KEY');
    expect(findSecret({ system: '', messages: [], tools: [{ name: 't', description: env.ANTHROPIC_API_KEY, input_schema: { type: 'object' } }] }, secrets)).toBe('ANTHROPIC_API_KEY');
  });
});
