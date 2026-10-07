// Stores the deployed mandates (public deployment record) in Postgres. Idempotent.
// Usage: pnpm --filter @authority/api seed <path to deployment json>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Deployment, chainBinding } from '@authority/cardano';
import { migrate, pgDb } from '@authority/db';
import { seedDeployment } from '../src/mandates';

const file = process.argv[2];
if (!file) throw new Error('usage: seed <deployment.json>');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = pgDb(url);
await migrate(db);
const raw = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8')) as Record<string, unknown>;
// Accept the Cardano deploy record (packages/cardano/deployments/preprod.json, keyed by mandate id) as well as the
// API seed shape. M-001 is the stage mandate; everything else is a lab mandate.
const deployment =
  'mandates' in raw
    ? raw
    : {
        network: 'preprod',
        mandates: Object.values(raw as Record<string, Deployment>).map((d) => ({
          kind: d.mandate_id === 'M-001' ? 'stage' : 'lab',
          delegate_name: d.mandate.delegate.id,
          mandate: d.mandate,
          binding: chainBinding(d),
        })),
      };
for (const line of await seedDeployment(db, deployment)) console.log(`seeded ${line}`);
await db.close();
