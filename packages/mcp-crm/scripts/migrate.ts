// Applies boondi-crm's own SQL migrations to the configured schema. Run with:
//   npm run migrate   (from packages/mcp-crm)
// Migrations are idempotent (IF NOT EXISTS / harmless GRANTs), so re-running is
// safe. Kept separate from Gantry core's migration runner to preserve the
// neutral-engine boundary (this table is Boondi-owned).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDotenvUpwards } from '../src/dotenv-load.js';

loadDotenvUpwards(path.dirname(fileURLToPath(import.meta.url)));

const databaseUrl =
  process.env.BOONDI_CRM_DATABASE_URL ?? process.env.GANTRY_DATABASE_URL;
const schema = (process.env.BOONDI_CRM_DB_SCHEMA ?? 'gantry').trim() || 'gantry';

if (!databaseUrl) {
  process.stderr.write(
    'Missing BOONDI_CRM_DATABASE_URL (or GANTRY_DATABASE_URL)\n',
  );
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
  process.stderr.write(`Refusing unsafe schema name: ${schema}\n`);
  process.exit(1);
}

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);
const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(`SET search_path TO ${schema}`);
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    process.stdout.write(`applying ${file} ...\n`);
    await client.query(sql);
  }
  process.stdout.write(
    `boondi-crm: applied ${files.length} migration(s) to schema "${schema}"\n`,
  );
} finally {
  await client.end();
}
