import type Anthropic from '@anthropic-ai/sdk';
import type { AgentModel, AssistantBlock, Message, ModelTurn, Provider } from './model';

/** The one call both providers share: Messages API, non-streaming. Anthropic and AnthropicBedrockMantle both fit. */
export interface MessagesClient {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Message> };
}

export const DEFAULT_MAX_TOKENS = 2048;

function toParam(m: Message): Anthropic.MessageParam {
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input })),
    };
  }
  return {
    role: 'user',
    content: m.content.map((b) =>
      b.type === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) },
    ),
  };
}

const STOPS = new Set(['end_turn', 'tool_use', 'max_tokens', 'refusal']);

export function fromMessage(res: Anthropic.Message): ModelTurn {
  const content: AssistantBlock[] = [];
  // Only text and client tool calls are part of the contract; thinking is never enabled, server tools never offered.
  for (const b of res.content) {
    if (b.type === 'text') content.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
  }
  const stop = res.stop_reason !== null && STOPS.has(res.stop_reason) ? (res.stop_reason as ModelTurn['stop']) : 'other';
  return { content, stop, model: res.model, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } };
}

/**
 * The same request for both providers: no temperature (rejected by current models), no tool_choice (`any`/`tool`
 * are rejected by Sonnet 5.5), no strict tools or structured outputs (not available on Bedrock).
 */
export function messagesModel(client: MessagesClient, o: { provider: Provider; modelId: string; maxTokens?: number }): AgentModel {
  return {
    provider: o.provider,
    modelId: o.modelId,
    async run(input) {
      const res = await client.messages.create({
        model: o.modelId,
        max_tokens: o.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: input.system,
        messages: input.messages.map(toParam),
        tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      });
      return fromMessage(res);
    },
  };
}
