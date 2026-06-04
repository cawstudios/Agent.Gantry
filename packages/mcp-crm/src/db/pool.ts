import pg from 'pg';
import type { Pool } from 'pg';

const { Pool: PgPool } = pg;

// A read-write pool for boondi-crm's own tables, scoped to the configured
// schema (default: gantry — the same DB the runtime/boondi-admin use).
export function createPool(databaseUrl: string, schema: string): Pool {
  return new PgPool({
    connectionString: databaseUrl,
    max: 5,
    options: `-c search_path=${schema} -c application_name=boondi-crm`,
  });
}
