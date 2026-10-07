import type { AgentModel, Message, ModelTurn, ToolDef, ToolUseBlock, UserBlock } from './model';

export interface ToolHandler {
  def: ToolDef;
  /** 'read' tools have no side effects. 'proposal' submits an Action IR for evaluation: the only side effect. */
  effect: 'read' | 'proposal';
  handle(input: unknown): Promise<string>;
}

/** A failure the model sees as an is_error tool result and may recover from. Any other error ends the conversation. */
export class ToolError extends Error {
  override name = 'ToolError';
}

export type LoopEvent =
  | { type: 'turn'; index: number; stop: ModelTurn['stop']; tools: string[]; text: string }
  | { type: 'tool'; name: string; is_error: boolean };

export interface Conversation {
  messages: Message[];
  turns: ModelTurn[];
  stop: ModelTurn['stop'] | 'max_turns';
  finalText: string;
}

export async function converse(o: {
  model: AgentModel;
  system: string;
  prompt: string;
  tools: ToolHandler[];
  maxTurns: number;
  onEvent?: (e: LoopEvent) => void;
}): Promise<Conversation> {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: o.prompt }] }];
  const byName = new Map(o.tools.map((t) => [t.def.name, t]));
  const defs = o.tools.map((t) => t.def);
  const turns: ModelTurn[] = [];
  for (let index = 0; index < o.maxTurns; index++) {
    const turn = await o.model.run({ system: o.system, messages: [...messages], tools: defs });
    turns.push(turn);
    const text = turn.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    const uses = turn.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    o.onEvent?.({ type: 'turn', index, stop: turn.stop, tools: uses.map((u) => u.name), text });
    // A turn cut off by max_tokens may carry a truncated tool input: never execute it.
    if (uses.length === 0 || turn.stop === 'max_tokens') return { messages, turns, stop: turn.stop, finalText: text };
    messages.push({ role: 'assistant', content: turn.content });
    const results: UserBlock[] = [];
    for (const use of uses) {
      const tool = byName.get(use.name);
      let content: string;
      let isError = false;
      if (!tool) {
        content = `unknown tool "${use.name}"; available tools: ${[...byName.keys()].join(', ')}`;
        isError = true;
      } else {
        try {
          content = await tool.handle(use.input);
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          content = error.message;
          isError = true;
        }
      }
      o.onEvent?.({ type: 'tool', name: use.name, is_error: isError });
      results.push({ type: 'tool_result', tool_use_id: use.id, content, is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }
  return { messages, turns, stop: 'max_turns', finalText: '' };
}
