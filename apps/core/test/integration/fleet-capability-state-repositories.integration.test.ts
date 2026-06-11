import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js';
import {
  PostgresStorageService,
  quotePostgresIdentifier,
} from '@core/adapters/storage/postgres/storage-service.js';
import { DEFAULT_APP_ID } from '@core/adapters/storage/postgres/seeds.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

const appId = DEFAULT_APP_ID;
const now = '2026-06-11T00:00:00.000Z';

maybeDescribe('Fleet capability-state repositories (0077)', () => {
  let service: PostgresStorageService;
  let repositories: PostgresDomainRepositoryBundle;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = `fleet_test_${process.pid}_${Date.now()}`;
    service = new PostgresStorageService(
      process.env.GANTRY_TEST_DATABASE_URL ?? '',
      schemaName,
    );
    // Applying migrations through 0077 proves the migration applies cleanly.
    await service.migrate();
    repositories = createPostgresDomainRepositories(service.db, service.pool);
  }, 60_000);

  afterAll(async () => {
    if (!service) return;
    await service.pool.query(
      `DROP SCHEMA IF EXISTS ${quotePostgresIdentifier(schemaName)} CASCADE`,
    );
    await service.close();
  });

  describe('runtimeDependencies', () => {
    it('creates a queued manifest idempotently on (appId, manifestHash)', async () => {
      const created =
        await repositories.runtimeDependencies.createRuntimeDependency({
          id: 'runtime-dependency:one',
          appId,
          manifestHash: 'sha256:manifest-one',
          requestedPackages: ['left-pad@1.3.0'],
          requestedByAgentId: 'agent:one',
          approvedByConversationId: 'conversation:approve',
          approvedAt: now,
          now,
        });
      expect(created.status).toBe('queued');
      expect(created.requestedPackages).toEqual(['left-pad@1.3.0']);
      expect(created.artifact).toBeNull();

      const duplicate =
        await repositories.runtimeDependencies.createRuntimeDependency({
          id: 'runtime-dependency:two',
          appId,
          manifestHash: 'sha256:manifest-one',
          requestedPackages: ['ignored@9.9.9'],
          now,
        });
      // Idempotent: returns the original row, does not start a second bake.
      expect(duplicate.id).toBe('runtime-dependency:one');
      expect(duplicate.requestedPackages).toEqual(['left-pad@1.3.0']);

      const list =
        await repositories.runtimeDependencies.listRuntimeDependencies({
          appId,
          statuses: ['queued'],
        });
      expect(list.some((row) => row.id === 'runtime-dependency:one')).toBe(
        true,
      );
    });

    it('transitions status and records produced artifact metadata', async () => {
      await repositories.runtimeDependencies.createRuntimeDependency({
        id: 'runtime-dependency:activate',
        appId,
        manifestHash: 'sha256:manifest-activate',
        requestedPackages: ['dayjs@1.11.20'],
        now,
      });
      const updated =
        await repositories.runtimeDependencies.updateRuntimeDependencyStatus({
          id: 'runtime-dependency:activate',
          status: 'activated',
          artifact: {
            storageType: 'object-store',
            storageRef: 'toolchains/sha256-manifest-activate',
            contentHash: 'sha256:bake-output',
            sizeBytes: 4096,
          },
          now,
        });
      expect(updated).toBe(true);

      const row = await repositories.runtimeDependencies.getRuntimeDependency(
        'runtime-dependency:activate',
      );
      expect(row?.status).toBe('activated');
      expect(row?.artifact).toMatchObject({
        storageType: 'object-store',
        contentHash: 'sha256:bake-output',
        sizeBytes: 4096,
      });
    });

    it('records a failure reason on a failed bake', async () => {
      await repositories.runtimeDependencies.createRuntimeDependency({
        id: 'runtime-dependency:fail',
        appId,
        manifestHash: 'sha256:manifest-fail',
        requestedPackages: ['totally-not-a-real-pkg@0.0.0'],
        now,
      });
      await repositories.runtimeDependencies.updateRuntimeDependencyStatus({
        id: 'runtime-dependency:fail',
        status: 'failed',
        failureReason: 'registry 404',
        now,
      });
      const row = await repositories.runtimeDependencies.getRuntimeDependency(
        'runtime-dependency:fail',
      );
      expect(row?.status).toBe('failed');
      expect(row?.failureReason).toBe('registry 404');
    });
  });

  describe('settingsRevisions', () => {
    it('allocates monotonic revisions per appId', async () => {
      const first = await repositories.settingsRevisions.appendSettingsRevision(
        {
          appId,
          settingsDocument: { agent: { name: 'rev-one' } },
          minReaderVersion: 0,
          createdBy: 'cli',
          note: 'first',
          now,
        },
      );
      expect(first.revision).toBe(1);

      const second =
        await repositories.settingsRevisions.appendSettingsRevision({
          appId,
          settingsDocument: { agent: { name: 'rev-two' } },
          minReaderVersion: 2,
          createdBy: 'api',
          now,
        });
      expect(second.revision).toBe(2);
      expect(second.minReaderVersion).toBe(2);

      const latest =
        await repositories.settingsRevisions.getLatestSettingsRevision(appId);
      expect(latest?.revision).toBe(2);
      expect(latest?.settingsDocument).toEqual({ agent: { name: 'rev-two' } });

      const byNumber = await repositories.settingsRevisions.getSettingsRevision(
        {
          appId,
          revision: 1,
        },
      );
      expect(byNumber?.note).toBe('first');

      const recent =
        await repositories.settingsRevisions.listRecentSettingsRevisions({
          appId,
          limit: 10,
        });
      expect(recent.map((row) => row.revision)).toEqual([2, 1]);
    });

    it('serializes concurrent appends without losing a revision', async () => {
      const before =
        await repositories.settingsRevisions.getLatestSettingsRevision(appId);
      const baseline = before?.revision ?? 0;
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          repositories.settingsRevisions.appendSettingsRevision({
            appId,
            settingsDocument: { seq: i },
            minReaderVersion: 0,
            createdBy: 'concurrent',
            now,
          }),
        ),
      );
      const revisions = results
        .map((row) => row.revision)
        .sort((a, b) => a - b);
      // Five distinct, contiguous revisions above the baseline.
      expect(new Set(revisions).size).toBe(5);
      expect(revisions[0]).toBeGreaterThan(baseline);
      expect(revisions[4]! - revisions[0]!).toBe(4);
    });
  });
});
