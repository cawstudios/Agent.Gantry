#!/usr/bin/env node

const value = process.env.MYCLAW_TEST_DATABASE_URL?.trim();

if (!value) {
  console.error('MYCLAW_TEST_DATABASE_URL is required for Postgres integration tests.');
  console.error(
    'Run with: MYCLAW_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/myclaw_test npm run test:integration:postgres',
  );
  process.exit(1);
}

try {
  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`unsupported protocol ${parsed.protocol}`);
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`MYCLAW_TEST_DATABASE_URL must be a valid postgres:// or postgresql:// URL: ${reason}`);
  process.exit(1);
}
