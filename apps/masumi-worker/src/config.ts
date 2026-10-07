import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SellerSourceSchema, type SellerSource } from '@authority/masumi';

// Public registration values written by apps/masumi-payment/scripts/register.ts.
export const REGISTRATION_FILE = fileURLToPath(new URL('../../masumi-payment/registration.preprod.json', import.meta.url));
const DEFAULT_STATE_DIR = fileURLToPath(new URL('../.state', import.meta.url));

export interface Config {
  paymentServiceUrl: string;
  paymentApiKey: string;
  authorityApiUrl: string;
  authorityApiKey: string;
  enginePublicKey: string;
  publicWebUrl: string;
  blockfrostKey: string;
  sokosumi: { coworkerId: string; apiKey: string } | null;
  paidTasks: boolean;
  source: SellerSource | null;
  stateDir: string;
  host: string;
  port: number;
}

export function readRegistration(file: string): SellerSource | null {
  if (!existsSync(file)) return null;
  const r = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (r.state !== 'RegistrationConfirmed' && r.state !== 'UpdateConfirmed') return null;
  return SellerSourceSchema.parse({
    agentIdentifier: r.agentIdentifier,
    supportedPaymentSourceIndex: r.supportedPaymentSourceIndex,
    smartContractAddress: r.smartContractAddress,
    policyId: r.policyId,
    sellerVkey: r.sellerVkey,
    sellerAddress: r.sellerAddress,
  });
}

// http is only for a loopback payment service or Railway's private network. Anywhere else the API key must go over https.
function paymentServiceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PAYMENT_SERVICE_URL is not a valid URL');
  }
  const host = url.hostname;
  const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || isIpv4Loopback(host);
  const internal = host === 'railway.internal' || host.endsWith('.railway.internal');
  if (url.protocol === 'https:' || (url.protocol === 'http:' && (loopback || internal))) return value;
  throw new Error('PAYMENT_SERVICE_URL must be https, or http only for loopback and *.railway.internal');
}

function isIpv4Loopback(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function enginePublicKey(value: string): string {
  const key = value.replace(/^ed25519:/, '');
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('AUTHORITY_ENGINE_PUBLIC_KEY must be 32 bytes of lowercase hex');
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv, registrationFile: string = REGISTRATION_FILE): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const coworkerId = env.SOKOSUMI_COWORKER_ID?.trim() ?? '';
  const coworkerKey = env.SOKOSUMI_COWORKER_API_KEY?.trim() ?? '';
  if ((coworkerId === '') !== (coworkerKey === '')) throw new Error('set both SOKOSUMI_COWORKER_ID and SOKOSUMI_COWORKER_API_KEY, or neither');
  const paidTasks = env.MASUMI_PAID_TASKS?.trim() === 'true';
  const source = readRegistration(registrationFile);
  if (paidTasks && source === null) throw new Error('MASUMI_PAID_TASKS=true needs a confirmed registration (run the register script)');
  return {
    paymentServiceUrl: paymentServiceUrl(required('PAYMENT_SERVICE_URL')),
    paymentApiKey: required('PAYMENT_API_KEY'),
    authorityApiUrl: required('AUTHORITY_API_URL'),
    authorityApiKey: required('AUTHORITY_API_KEY'),
    enginePublicKey: enginePublicKey(required('AUTHORITY_ENGINE_PUBLIC_KEY')),
    publicWebUrl: required('PUBLIC_WEB_URL'),
    blockfrostKey: paidTasks ? required('BLOCKFROST_PROJECT_ID_PREPROD') : (env.BLOCKFROST_PROJECT_ID_PREPROD?.trim() ?? ''),
    sokosumi: coworkerId === '' ? null : { coworkerId, apiKey: coworkerKey },
    paidTasks,
    source,
    stateDir: env.MASUMI_STATE_DIR?.trim() || DEFAULT_STATE_DIR,
    host: env.HOST?.trim() || '127.0.0.1',
    port: Number(env.PORT ?? '3013'),
  };
}
