// Applies the schema to DATABASE_URL. Usage: pnpm --filter @authority/db migrate
import { migrate, pgDb } from './db';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = pgDb(url);
await migrate(db);
await db.close();
console.log('schema applied');
