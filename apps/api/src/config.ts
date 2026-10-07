import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { hexOfLength } from '@authority/core';
import { getAddress } from 'viem';

/** Engine key env name per mandate id. The Attack Lab reads its own M_LAB_* keys separately (lab.ts). */
export const ENGINE_KEY_ENV = { 'M-001': 'M001_ENGINE_SECRET_KEY', 'M-LAB': 'M_LAB_ENGINE_SECRET_KEY' } as const;

export type CreMode = { mode: 'local'; workflowsDir: string; envFile: string; creBin: string } | { mode: 'relay' };

export interface Config {
  port: number;
  databaseUrl: string;
  publicApiUrl: string;
  webOrigins: string[];
  keys: { agent: string | undefined; masumi: string | undefined; relay: string | undefined };
  engineKeys: Map<string, Uint8Array>;
  stripeReadKey: string;
  stripeSettlementKey: string;
  stripeCustomerId: string;
  sepoliaRpcUrl: string;
  registry: `0x${string}`;
  cre: CreMode;
  /** Deployment record to seed mandates from at startup (relative to the repo root). */
  deploymentFile: string | undefined;
  /** Escalation bond in lovelace (ESCALATION_BOND_LOVELACE, default 5 ADA). */
  escalationBondLovelace: string;
  /** x402 facilitator base URL for exact-scheme bond locks (X402_FACILITATOR_URL); undefined = submit locally. */
  x402FacilitatorUrl: string | undefined;
}

const ROOT = resolve(import.meta.dirname, '../../..');

export function loadConfig(env: Record<string, string | undefined>): Config {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const optional = (name: string) => env[name]?.trim() || undefined;
  const engineKeys = new Map<string, Uint8Array>();
  for (const [mandateId, name] of Object.entries(ENGINE_KEY_ENV)) engineKeys.set(mandateId, hexOfLength(need(name), 32, name));
  const agent = optional('AUTHORITY_AGENT_KEY');
  const masumi = optional('AUTHORITY_MASUMI_KEY');
  const relay = optional('CRE_RELAY_KEY');
  for (const [name, value] of [['AUTHORITY_AGENT_KEY', agent], ['AUTHORITY_MASUMI_KEY', masumi], ['CRE_RELAY_KEY', relay]] as const) {
    if (value !== undefined && value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  }
  const mode = optional('CRE_TRIGGER_MODE') ?? 'local';
  if (mode !== 'local' && mode !== 'relay') throw new Error('CRE_TRIGGER_MODE must be local or relay');
  if (mode === 'relay' && relay === undefined) throw new Error('CRE_TRIGGER_MODE=relay needs CRE_RELAY_KEY');
  const bond = optional('ESCALATION_BOND_LOVELACE') ?? '5000000';
  if (!/^[1-9]\d{0,18}$/.test(bond)) throw new Error('ESCALATION_BOND_LOVELACE must be a positive integer (lovelace)');
  return {
    escalationBondLovelace: bond,
    x402FacilitatorUrl: optional('X402_FACILITATOR_URL')?.replace(/\/+$/, ''),
    port: Number(optional('PORT') ?? 8788),
    databaseUrl: need('DATABASE_URL'),
    publicApiUrl: (optional('PUBLIC_API_URL') ?? '').replace(/\/+$/, ''),
    webOrigins: (optional('WEB_ORIGINS') ?? 'http://localhost:3100').split(',').map((s) => s.trim()).filter(Boolean),
    keys: { agent, masumi, relay },
    engineKeys,
    stripeReadKey: need('STRIPE_READ_KEY'),
    stripeSettlementKey: need('STRIPE_SETTLEMENT_KEY'),
    stripeCustomerId: need('STRIPE_ACME_CUSTOMER_ID'),
    sepoliaRpcUrl: need('SEPOLIA_RPC_URL'),
    registry: getAddress(need('VERIFICATION_REGISTRY_ADDRESS')),
    deploymentFile: optional('DEPLOYMENT_FILE') === undefined ? undefined : resolve(ROOT, optional('DEPLOYMENT_FILE')!),
    cre:
      mode === 'relay'
        ? { mode: 'relay' }
        : localCre({
            mode: 'local',
            workflowsDir: optional('CRE_WORKFLOWS_DIR') ?? resolve(ROOT, 'workflows'),
            envFile: optional('CRE_ENV_FILE') ?? resolve(ROOT, '.env'),
            creBin: optional('CRE_BIN') ?? defaultCreBin(env.HOME),
          }),
  };
}

/** The CRE installer puts the CLI in ~/.cre/bin, which a service started outside a login shell does not have on PATH. */
export function defaultCreBin(home = homedir()): string {
  const installed = join(home, '.cre', 'bin', 'cre');
  return existsSync(installed) ? installed : 'cre';
}

/** Names-only secret mapping the simulator needs next to the workflow (`secrets-path` in workflow.yaml). */
export const CRE_SECRETS_FILE = 'cre-secrets.yaml';

// Checked at startup: a missing file would otherwise surface only as VERIFICATION_UNAVAILABLE on the first escalation.
function localCre(cre: Extract<CreMode, { mode: 'local' }>): CreMode {
  for (const [what, path] of [
    ['CRE_ENV_FILE', cre.envFile],
    ['CRE_WORKFLOWS_DIR', join(cre.workflowsDir, 'cre-verifier', 'workflow.yaml')],
    ['CRE_WORKFLOWS_DIR', join(cre.workflowsDir, CRE_SECRETS_FILE)],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${what}: ${path} does not exist`);
  }
  return cre;
}
