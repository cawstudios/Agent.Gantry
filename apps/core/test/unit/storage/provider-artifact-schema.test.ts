import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

describe('provider session artifact schema', () => {
  it('stores provider artifacts as metadata plus backend refs', () => {
    const schema = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/core/src/adapters/storage/postgres/schema/sessions.ts',
      ),
      'utf8',
    );
    const migration = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/core/src/adapters/storage/postgres/schema/migrations/0014_provider_session_artifacts.sql',
      ),
      'utf8',
    );

    expect(schema).toContain("'provider_session_artifacts'");
    expect(schema).toContain("latestArtifactId: text('latest_artifact_id')");
    expect(schema).toContain("storageType: text('storage_type').notNull()");
    expect(schema).toContain("storageRef: text('storage_ref').notNull()");
    expect(schema).toContain("contentHash: text('content_hash').notNull()");
    expect(schema).toContain('contentText: text');
    expect(migration).not.toContain('DROP COLUMN IF EXISTS artifact_ref');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS provider_session_artifacts',
    );
  });
});
