import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { messagesModel } from './messages';
import type { AgentModel, Provider } from './model';

export const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-sonnet-5-5',
  bedrock: 'anthropic.claude-sonnet-5-5',
};
const TIMEOUT_MS = 120_000;

export function anthropicAdapter(o: { apiKey: string; modelId?: string; baseURL?: string; maxTokens?: number }): AgentModel {
  const client = new Anthropic({ apiKey: o.apiKey, maxRetries: 2, timeout: TIMEOUT_MS, ...(o.baseURL ? { baseURL: o.baseURL } : {}) });
  return messagesModel(client, { provider: 'anthropic', modelId: o.modelId ?? DEFAULT_MODEL.anthropic, ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}) });
}

/**
 * Claude in Amazon Bedrock (Messages API at bedrock-mantle.{region}.api.aws/anthropic). Credentials come from the
 * standard AWS chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, profile, role) or
 * AWS_BEARER_TOKEN_BEDROCK; `apiKey` is only for tests against a local server.
 */
export function bedrockAdapter(o: { awsRegion: string; modelId?: string; baseURL?: string; apiKey?: string; maxTokens?: number }): AgentModel {
  const client = new AnthropicBedrockMantle({
    awsRegion: o.awsRegion,
    maxRetries: 2,
    timeout: TIMEOUT_MS,
    ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    ...(o.apiKey ? { apiKey: o.apiKey } : {}),
  });
  return messagesModel(client, { provider: 'bedrock', modelId: o.modelId ?? DEFAULT_MODEL.bedrock, ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}) });
}

export function providerOf(env: Record<string, string | undefined>): Provider {
  const p = env.AGENT_MODEL_PROVIDER?.trim() || 'anthropic';
  if (p !== 'anthropic' && p !== 'bedrock') throw new Error('AGENT_MODEL_PROVIDER must be anthropic or bedrock');
  return p;
}

/** AGENT_MODEL_PROVIDER=anthropic|bedrock picks the adapter; nothing else changes between providers. */
export function modelFromEnv(env: Record<string, string | undefined>): AgentModel {
  const provider = providerOf(env);
  const opt = (name: string) => env[name]?.trim() || undefined;
  const need = (name: string) => {
    const v = opt(name);
    if (!v) throw new Error(`${name} is not set (AGENT_MODEL_PROVIDER=${provider})`);
    return v;
  };
  if (provider === 'anthropic') {
    const modelId = opt('ANTHROPIC_MODEL_ID');
    return anthropicAdapter({ apiKey: need('ANTHROPIC_API_KEY'), ...(modelId ? { modelId } : {}) });
  }
  const modelId = opt('BEDROCK_MODEL_ID');
  return bedrockAdapter({ awsRegion: need('AWS_REGION'), ...(modelId ? { modelId } : {}) });
}

/** Whether the selected provider has what it needs; lets a service run without a model (features stay off). */
export function modelConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(providerOf(env) === 'anthropic' ? env.ANTHROPIC_API_KEY?.trim() : env.AWS_REGION?.trim());
}
