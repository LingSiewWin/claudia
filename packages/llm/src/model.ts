// Provider-neutral model contract. The runtime talks only to AgentModel; adapters translate to a provider.

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error: boolean;
}
export type AssistantBlock = TextBlock | ToolUseBlock;
export type UserBlock = TextBlock | ToolResultBlock;
export type Message = { role: 'user'; content: UserBlock[] } | { role: 'assistant'; content: AssistantBlock[] };

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; [key: string]: unknown };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ModelTurn {
  content: AssistantBlock[];
  stop: StopReason;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface ModelInput {
  system: string;
  messages: Message[];
  tools: ToolDef[];
}

export type Provider = 'anthropic' | 'bedrock';

export interface AgentModel {
  readonly provider: Provider | 'scripted';
  readonly modelId: string;
  run(input: ModelInput): Promise<ModelTurn>;
}
