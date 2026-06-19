import {
  closeRuntimeStorage,
  getRuntimeStorage,
  initializeRuntimeStorage,
} from '../../dist/adapters/storage/postgres/runtime-store.js';
import { loadRuntimeSettingsFromPath } from '../../dist/config/index.js';
import { importFleetSettingsRevision } from '../../dist/config/settings/settings-import-service.js';

const settingsPath = process.argv[2];
if (!settingsPath) {
  console.error('usage: node /app/ops/docker/fleet-settings-seed.mjs <settings.yaml>');
  process.exit(1);
}

await initializeRuntimeStorage();
try {
  const storage = getRuntimeStorage();
  const settings = loadRuntimeSettingsFromPath(settingsPath);
  const outcome = await importFleetSettingsRevision(
    {
      runtimeHome: process.env.GANTRY_HOME || '/var/lib/gantry',
      ops: storage.ops,
      repositories: storage.repositories,
      appId: 'default',
      settingsRevisions: storage.repositories.settingsRevisions,
      pool: storage.service.pool,
      createdBy: 'docker:fleet-settings-seed',
    },
    settings,
  );

  if (outcome.status === 'invalid') {
    console.error('fleet settings seed failed validation:');
    for (const error of outcome.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  if (outcome.status === 'conflict') {
    console.error(
      `fleet settings seed conflict: expected ${outcome.expectedRevision}, current ${outcome.actualRevision}`,
    );
    process.exit(1);
  }

  console.log(`fleet settings revision ${outcome.revision} seeded`);
} finally {
  await closeRuntimeStorage();
}
