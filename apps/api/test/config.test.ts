import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCreBin, loadConfig } from '../src/config';

const hex32 = 'ab'.repeat(32);
const base = {
  M001_ENGINE_SECRET_KEY: hex32,
  M_LAB_ENGINE_SECRET_KEY: hex32,
  DATABASE_URL: 'postgres://x',
  STRIPE_READ_KEY: 'rk_test_read',
  STRIPE_SETTLEMENT_KEY: 'rk_test_settle',
  STRIPE_ACME_CUSTOMER_ID: 'cus_1',
  SEPOLIA_RPC_URL: 'https://rpc.invalid',
  VERIFICATION_REGISTRY_ADDRESS: '0xbC0fE56c6F7b42F679A08E0549B14c9dbF69A31B',
};

// A workflows dir as a clone has it: workflow.yaml plus the names-only secrets mapping.
const workflows = (secrets = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'cre-'));
  mkdirSync(join(dir, 'cre-verifier'));
  writeFileSync(join(dir, 'cre-verifier', 'workflow.yaml'), '');
  if (secrets) writeFileSync(join(dir, 'cre-secrets.yaml'), 'secretsNames: {}\n');
  return dir;
};
const envFile = () => {
  const f = join(mkdtempSync(join(tmpdir(), 'env-')), '.env');
  writeFileSync(f, '');
  return f;
};

describe('CRE local mode config', () => {
  it('uses the CLI from ~/.cre/bin when CRE_BIN is unset, so a service without a login PATH still finds it', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.cre', 'bin'), { recursive: true });
    writeFileSync(join(home, '.cre', 'bin', 'cre'), '');
    expect(defaultCreBin(home)).toBe(join(home, '.cre', 'bin', 'cre'));
    const cfg = loadConfig({ ...base, HOME: home, CRE_WORKFLOWS_DIR: workflows(), CRE_ENV_FILE: envFile() });
    expect(cfg.cre).toMatchObject({ mode: 'local', creBin: join(home, '.cre', 'bin', 'cre') });
  });

  it('falls back to `cre` on PATH when nothing is installed under ~/.cre, and CRE_BIN wins over both', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    expect(defaultCreBin(home)).toBe('cre');
    const cfg = loadConfig({ ...base, HOME: home, CRE_BIN: '/opt/cre', CRE_WORKFLOWS_DIR: workflows(), CRE_ENV_FILE: envFile() });
    expect(cfg.cre).toMatchObject({ creBin: '/opt/cre' });
  });

  it('refuses to start without the secrets mapping the simulator reads', () => {
    expect(() => loadConfig({ ...base, CRE_WORKFLOWS_DIR: workflows(false), CRE_ENV_FILE: envFile() })).toThrow(/cre-secrets\.yaml does not exist/);
  });

  it('refuses to start without the env file passed to the simulator', () => {
    expect(() => loadConfig({ ...base, CRE_WORKFLOWS_DIR: workflows(), CRE_ENV_FILE: '/nonexistent/.env' })).toThrow(/CRE_ENV_FILE: \/nonexistent\/.env does not exist/);
  });

  it('relay mode needs no CLI or files', () => {
    const cfg = loadConfig({ ...base, CRE_TRIGGER_MODE: 'relay', CRE_RELAY_KEY: 'r'.repeat(32), CRE_WORKFLOWS_DIR: '/nonexistent' });
    expect(cfg.cre).toEqual({ mode: 'relay' });
  });
});
