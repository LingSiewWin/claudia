import type { AgentModel, ModelInput, ModelTurn } from './model';

// Deterministic stand-in for a provider, for tests: a script decides each turn from the request it receives.

export type Script = (input: ModelInput, call: number) => ModelTurn | Promise<ModelTurn>;

export interface ScriptedModel extends AgentModel {
  /** Every request the runtime sent, deep-copied. */
  readonly inputs: ModelInput[];
}

export function scriptedModel(script: Script): ScriptedModel {
  const inputs: ModelInput[] = [];
  return {
    provider: 'scripted',
    modelId: 'scripted',
    inputs,
    async run(input) {
      inputs.push(structuredClone(input));
      return script(input, inputs.length - 1);
    },
  };
}

let ids = 0;
export const say = (text: string): ModelTurn => ({ content: [{ type: 'text', text }], stop: 'end_turn', model: 'scripted', usage: { input_tokens: 0, output_tokens: 0 } });
export const useTool = (name: string, input: unknown, text?: string): ModelTurn => ({
  content: [...(text ? [{ type: 'text' as const, text }] : []), { type: 'tool_use', id: `toolu_${++ids}`, name, input }],
  stop: 'tool_use',
  model: 'scripted',
  usage: { input_tokens: 0, output_tokens: 0 },
});

/** The tool results of the newest user message, by tool name of the call they answer. */
export function lastResults(input: ModelInput): { name: string; content: string; is_error: boolean }[] {
  const last = input.messages.at(-1);
  const prev = input.messages.at(-2);
  if (!last || last.role !== 'user' || !prev || prev.role !== 'assistant') return [];
  const names = new Map(prev.content.flatMap((b) => (b.type === 'tool_use' ? [[b.id, b.name] as const] : [])));
  return last.content.flatMap((b) => (b.type === 'tool_result' ? [{ name: names.get(b.tool_use_id) ?? '?', content: b.content, is_error: b.is_error }] : []));
}

/** The text of the first user message (the work item prompt). */
export const promptOf = (input: ModelInput) => {
  const first = input.messages[0];
  return first?.role === 'user' ? first.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') : '';
};
