// Stores the deployed mandates (public deployment record) in Postgres. Idempotent.
// Usage: pnpm --filter @authority/api seed <path to deployment json>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate, pgDb } from '@authority/db';
import { seedDeployment } from '../src/mandates';

const file = process.argv[2];
if (!file) throw new Error('usage: seed <deployment.json>');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = pgDb(url);
await migrate(db);
for (const line of await seedDeployment(db, JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8')))) console.log(`seeded ${line}`);
await db.close();
