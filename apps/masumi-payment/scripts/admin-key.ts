// Registers MPS_ADMIN_KEY in the payment service database the way Masumi's prisma seed does (the Docker image
// cannot run that seed). Hash per payment-core api-key-hash.ts: PBKDF2-SHA512, 100k rounds, salt = scrypt(ENCRYPTION_KEY).
// Idempotent. Usage: pnpm --filter @authority/masumi-payment admin-key
import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomUUID, scryptSync } from 'node:crypto';
import { join } from 'node:path';

const adminKey = process.env.MPS_ADMIN_KEY ?? '';
const encryptionKey = process.env.MPS_ENCRYPTION_KEY ?? '';
if (adminKey.length < 15 || encryptionKey.length < 20) throw new Error('MPS_ADMIN_KEY (>= 15 chars) and MPS_ENCRYPTION_KEY (>= 20 chars) must be set in .env');

const salt = scryptSync(encryptionKey, 'masumi-apikey-pbkdf2-salt-v1', 32);
const tokenHash = pbkdf2Sync(adminKey, salt, 100_000, 64, 'sha512').toString('hex');
const sql = `insert into "ApiKey" (id, "updatedAt", token, "tokenHash", status, "canRead", "canPay", "canAdmin", "networkLimit")
  values ('${randomUUID()}', now(), '*****${adminKey.slice(-4)}', '${tokenHash}', 'Active', true, true, true, '{}')
  on conflict ("tokenHash") do update set status = 'Active', "canAdmin" = true, "updatedAt" = now();
select count(*) as admin_keys from "ApiKey" where "canAdmin" and status = 'Active';`;
const out = execFileSync('docker', ['compose', '--env-file', '../../.env', 'exec', '-T', 'postgres', 'psql', '-U', 'mps', '-d', 'mps_preprod', '-tAc', sql], {
  cwd: join(import.meta.dirname, '..'),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
console.log(JSON.stringify({ adminKeyRegistered: true, activeAdminKeys: Number(out.trim().split('\n').at(-1)) }));
