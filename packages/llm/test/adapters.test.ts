import { afterEach, describe, expect, it } from 'vitest';
import { anthropicAdapter, bedrockAdapter, DEFAULT_MODEL, type Message, modelConfigured, modelFromEnv, type ToolDef } from '../src';
import { fakeMessagesServer, message } from './fake-messages-server';

const tool: ToolDef = { name: 'read_mandate', description: 'Read the mandate.', input_schema: { type: 'object', properties: {}, additionalProperties: false } };
const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Process INV-3821.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_mandate', input: {} }] },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}', is_error: false },
      { type: 'text', text: 'continue' },
    ],
  },
];

let server: Awaited<ReturnType<typeof fakeMessagesServer>> | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const providers = [
  { name: 'anthropic', make: (url: string) => anthropicAdapter({ apiKey: 'test-key', baseURL: url }), path: '/v1/messages', model: DEFAULT_MODEL.anthropic },
  {
    name: 'bedrock',
    make: (url: string) => bedrockAdapter({ awsRegion: 'us-east-1', apiKey: 'test-bearer', baseURL: `${url}/anthropic` }),
    path: '/anthropic/v1/messages',
    model: DEFAULT_MODEL.bedrock,
  },
] as const;

describe.each(providers)('$name adapter contract', ({ name, make, path, model }) => {
  it('sends the shared Messages request: system, tools, history, no temperature or tool_choice', async () => {
    server = await fakeMessagesServer(() => ({ status: 200, json: message([{ type: 'text', text: 'done' }], 'end_turn') }));
    await make(server.url).run({ system: 'You are CFO-Agent-01.', messages: history, tools: [tool] });
    const [req] = server.seen;
    expect(req!.path).toBe(path);
    expect(req!.headers['anthropic-version']).toBe('2023-06-01');
    if (name === 'anthropic') expect(req!.headers['x-api-key']).toBe('test-key');
    else expect(req!.headers.authorization).toBe('Bearer test-bearer');
    expect(req!.body).toEqual({
      model,
      max_tokens: 2048,
      system: 'You are CFO-Agent-01.',
      tools: [tool],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Process INV-3821.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_mandate', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }, { type: 'text', text: 'continue' }] },
      ],
    });
  });

  it('maps text and tool_use blocks, drops anything else, and maps the stop reason', async () => {
    server = await fakeMessagesServer(() => ({
      status: 200,
      json: message([
        { type: 'thinking', thinking: 'hidden', signature: 'sig' },
        { type: 'text', text: 'Paying it.', citations: null },
        { type: 'tool_use', id: 'toolu_9', name: 'propose_action', input: { amount: '8.42' }, caller: { type: 'direct' } },
      ]),
    }));
    const turn = await make(server.url).run({ system: 's', messages: history.slice(0, 1), tools: [tool] });
    expect(turn).toEqual({
      content: [
        { type: 'text', text: 'Paying it.' },
        { type: 'tool_use', id: 'toolu_9', name: 'propose_action', input: { amount: '8.42' } },
      ],
      stop: 'tool_use',
      model: 'claude-sonnet-5-5',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
  });

  it('marks failed tool results with is_error and maps unknown stop reasons to other', async () => {
    server = await fakeMessagesServer(() => ({ status: 200, json: message([{ type: 'text', text: 'paused' }], 'pause_turn') }));
    const failed: Message[] = [history[0]!, history[1]!, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }] }];
    const turn = await make(server.url).run({ system: 's', messages: failed, tools: [tool] });
    expect(server.seen[0]!.body.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }]);
    expect(turn.stop).toBe('other');
  });

  it('surfaces a provider 400 as an error with its status', async () => {
    server = await fakeMessagesServer(() => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad tools' } } }));
    await expect(make(server.url).run({ system: 's', messages: history.slice(0, 1), tools: [tool] })).rejects.toMatchObject({ status: 400 });
  });
});

describe('modelFromEnv', () => {
  it('defaults to anthropic with the Sonnet model', () => {
    const m = modelFromEnv({ ANTHROPIC_API_KEY: 'sk-test' });
    expect([m.provider, m.modelId]).toEqual(['anthropic', 'claude-sonnet-5-5']);
  });
  it('switches to bedrock by AGENT_MODEL_PROVIDER alone', () => {
    const m = modelFromEnv({ AGENT_MODEL_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1' });
    expect([m.provider, m.modelId]).toEqual(['bedrock', 'anthropic.claude-sonnet-5-5']);
  });
  it('takes model id overrides per provider', () => {
    expect(modelFromEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL_ID: 'claude-sonnet-5' }).modelId).toBe('claude-sonnet-5');
    expect(modelFromEnv({ AGENT_MODEL_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1', BEDROCK_MODEL_ID: 'anthropic.claude-sonnet-5' }).modelId).toBe('anthropic.claude-sonnet-5');
  });
  it('fails closed on a missing key, region, or unknown provider', () => {
    expect(() => modelFromEnv({})).toThrow('ANTHROPIC_API_KEY is not set');
    expect(() => modelFromEnv({ AGENT_MODEL_PROVIDER: 'bedrock' })).toThrow('AWS_REGION is not set');
    expect(() => modelFromEnv({ AGENT_MODEL_PROVIDER: 'openai' })).toThrow('AGENT_MODEL_PROVIDER must be anthropic or bedrock');
  });
  it('reports whether the selected provider is configured', () => {
    expect([modelConfigured({}), modelConfigured({ ANTHROPIC_API_KEY: 'k' }), modelConfigured({ AGENT_MODEL_PROVIDER: 'bedrock', ANTHROPIC_API_KEY: 'k' })]).toEqual([false, true, false]);
  });
});
