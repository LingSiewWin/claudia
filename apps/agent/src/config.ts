import { hexOfLength } from '@authority/core';

/** Env var holding each mandate's agent signing key. The key signs proposals in this process and nowhere else. */
export const AGENT_KEY_ENV = { 'M-001': 'M001_AGENT_SECRET_KEY', 'M-LAB': 'M_LAB_AGENT_SECRET_KEY' } as const;

export interface AgentConfig {
  apiUrl: string;
  apiKey: string;
  agentKeys: Map<string, Uint8Array>;
  stripeReadKey: string;
  customerId: string;
  pollMs: number;
  resolveTimeoutMs: number;
  maxTurns: number;
}

const int = (env: Record<string, string | undefined>, name: string, fallback: number, min: number) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isSafeInteger(v) || v < min) throw new Error(`${name} must be an integer >= ${min}`);
  return v;
};

export function loadConfig(env: Record<string, string | undefined>): AgentConfig {
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const apiKey = need('AUTHORITY_AGENT_KEY');
  if (apiKey.length < 32) throw new Error('AUTHORITY_AGENT_KEY must be at least 32 characters');
  const agentKeys = new Map<string, Uint8Array>();
  for (const [mandateId, name] of Object.entries(AGENT_KEY_ENV)) {
    const hex = env[name]?.trim();
    if (hex) agentKeys.set(mandateId, hexOfLength(hex, 32, name));
  }
  if (agentKeys.size === 0) throw new Error(`set at least one of ${Object.values(AGENT_KEY_ENV).join(', ')}`);
  return {
    apiUrl: need('AUTHORITY_API_URL').replace(/\/+$/, ''),
    apiKey,
    agentKeys,
    stripeReadKey: need('STRIPE_READ_KEY'),
    customerId: need('STRIPE_ACME_CUSTOMER_ID'),
    pollMs: int(env, 'AGENT_POLL_MS', 3_000, 250),
    resolveTimeoutMs: int(env, 'AGENT_RESOLVE_TIMEOUT_MS', 900_000, 1_000),
    maxTurns: int(env, 'AGENT_MAX_TURNS', 12, 2),
  };
}
