import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, readRegistration } from '../src/config';
import { SOURCE } from './fakes';

const ENGINE_KEY = 'ab'.repeat(32);
const ENV = {
  PAYMENT_SERVICE_URL: 'http://127.0.0.1:3012/api/v1',
  PAYMENT_API_KEY: 'p',
  AUTHORITY_API_URL: 'http://127.0.0.1:4000',
  AUTHORITY_API_KEY: 'a',
  PUBLIC_WEB_URL: 'https://authority.example',
  AUTHORITY_ENGINE_PUBLIC_KEY: ENGINE_KEY,
};
const file = (content: object): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'reg-')), 'registration.preprod.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
};

describe('config', () => {
  it('needs both coworker values or neither', () => {
    expect(() => loadConfig({ ...ENV, SOKOSUMI_COWORKER_ID: 'x' }, '/nonexistent')).toThrow(/both/);
    expect(loadConfig(ENV, '/nonexistent').sokosumi).toBeNull();
  });

  it('paid Tasks need a confirmed registration', () => {
    expect(() => loadConfig({ ...ENV, MASUMI_PAID_TASKS: 'true', BLOCKFROST_PROJECT_ID_PREPROD: 'b' }, '/nonexistent')).toThrow(/registration/);
    expect(loadConfig({ ...ENV, MASUMI_PAID_TASKS: 'true', BLOCKFROST_PROJECT_ID_PREPROD: 'b' }, file({ ...SOURCE, state: 'RegistrationConfirmed' })).source).toEqual(SOURCE);
  });

  it('only a confirmed registration (or confirmed update) is used', () => {
    expect(readRegistration(file({ ...SOURCE, state: 'RegistrationRequested' }))).toBeNull();
    expect(readRegistration(file({ ...SOURCE, state: 'UpdateRequested' }))).toBeNull();
    expect(readRegistration(file({ ...SOURCE, state: 'UpdateConfirmed' }))).toEqual(SOURCE);
  });

  it('reports the first missing variable', () => {
    expect(() => loadConfig({ ...ENV, AUTHORITY_API_KEY: '' }, '/nonexistent')).toThrow('AUTHORITY_API_KEY is required');
  });

  it('requires a 32-byte engine public key', () => {
    expect(() => loadConfig({ ...ENV, AUTHORITY_ENGINE_PUBLIC_KEY: '' }, '/nonexistent')).toThrow('AUTHORITY_ENGINE_PUBLIC_KEY is required');
    expect(() => loadConfig({ ...ENV, AUTHORITY_ENGINE_PUBLIC_KEY: 'abcd' }, '/nonexistent')).toThrow(/32 bytes/);
    expect(loadConfig({ ...ENV, AUTHORITY_ENGINE_PUBLIC_KEY: `ed25519:${ENGINE_KEY}` }, '/nonexistent').enginePublicKey).toBe(ENGINE_KEY);
  });

  it('allows http for the payment service only on loopback and railway.internal', () => {
    expect(() => loadConfig({ ...ENV, PAYMENT_SERVICE_URL: 'http://payments.example/api/v1' }, '/nonexistent')).toThrow(/https/);
    expect(loadConfig({ ...ENV, PAYMENT_SERVICE_URL: 'https://payments.example/api/v1' }, '/nonexistent').paymentServiceUrl).toBe(
      'https://payments.example/api/v1',
    );
    expect(loadConfig({ ...ENV, PAYMENT_SERVICE_URL: 'http://mps.railway.internal:3012/api/v1' }, '/nonexistent').paymentServiceUrl).toBe(
      'http://mps.railway.internal:3012/api/v1',
    );
    expect(loadConfig({ ...ENV, PAYMENT_SERVICE_URL: 'http://[::1]:3012/api/v1' }, '/nonexistent').paymentServiceUrl).toBe('http://[::1]:3012/api/v1');
  });
});
