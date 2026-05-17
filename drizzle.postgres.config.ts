import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/core/src/storage/postgres/schema.ts',
  out: './apps/core/src/storage/postgres/migrations',
  dbCredentials: {
    url: process.env.GANTRY_DATABASE_URL || 'postgres://localhost/gantry',
  },
});
