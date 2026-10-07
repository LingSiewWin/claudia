import type { AgentModel } from './model';

// The model never sees a key. Every request is scanned for every secret value present in this process's
// environment before it leaves; a hit aborts the request and names the variable (never the value).

export interface Secret {
  name: string;
  value: string;
}

const SECRET_NAME = /SECRET|PRIVATE|MNEMONIC|PASSWORD|TOKEN|API_KEY|ACCESS_KEY|_KEY$|PROJECT_ID/;
const SECRET_URLS = new Set(['DATABASE_URL', 'SEPOLIA_RPC_URL']);
const MIN_SECRET_LENGTH = 12;

export class SecretLeakError extends Error {
  constructor(readonly secretName: string) {
    super(`refusing to send ${secretName} to the model`);
    this.name = 'SecretLeakError';
  }
}

export function secretsFromEnv(env: Record<string, string | undefined>): Secret[] {
  const out: Secret[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_NAME.test(name) || SECRET_URLS.has(name)) out.push({ name, value });
  }
  return out;
}

function strings(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  }
  return out;
}

/** The name of the first secret found anywhere in `value` (hex secrets match in any case), or null. */
export function findSecret(value: unknown, secrets: Secret[]): string | null {
  const text = strings(value, []).join('\n');
  const lower = text.toLowerCase();
  for (const s of secrets) {
    if (text.includes(s.value)) return s.name;
    if (/^[0-9a-fA-F]+$/.test(s.value) && lower.includes(s.value.toLowerCase())) return s.name;
  }
  return null;
}

export interface GuardedModel extends AgentModel {
  /** Requests scanned so far (all of them reached the model clean). */
  readonly scanned: () => number;
}

export function guardModel(model: AgentModel, secrets: Secret[]): GuardedModel {
  let scanned = 0;
  return {
    provider: model.provider,
    modelId: model.modelId,
    scanned: () => scanned,
    async run(input) {
      const hit = findSecret(input, secrets);
      if (hit !== null) throw new SecretLeakError(hit);
      scanned += 1;
      return model.run(input);
    },
  };
}
