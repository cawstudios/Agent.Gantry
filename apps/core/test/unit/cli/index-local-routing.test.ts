import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-cli-db-'));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/infrastructure/service/manager.js');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/adapters/storage/postgres/storage-service.js');
  vi.doUnmock('@core/cli/provider.js');
  vi.doUnmock('@core/cli/local.js');
  vi.doUnmock('@core/app/index.js');
  vi.doUnmock('@core/config/preflight.js');
  vi.doUnmock('@clack/prompts');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('CLI local routing', () => {
  it('does not override CLI settings storage resolution when URL lives in runtime .env', async () => {
    const runtimeHome = makeRuntimeHome();
    const originalGantryHome = process.env.GANTRY_HOME;
    const originalDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    delete process.env.GANTRY_DATABASE_URL;
    process.env.GANTRY_HOME = runtimeHome;
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'GANTRY_DATABASE_URL=postgres://user:pass@localhost:5432/gantry\n',
    );
    let storageProvider:
      | Parameters<
          (typeof import('@core/config/settings/runtime-settings.js'))['configureDesiredSettingsStorageProvider']
        >[0]
      | undefined;
    const initializeRuntimeStorage = vi.fn(async () => ({
      ops: {},
      repositories: { settingsRevisions: {} },
      service: { pool: {} },
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      configureDesiredSettingsStorageProvider: vi.fn((provider) => {
        storageProvider = provider;
      }),
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      getRuntimeStorage: vi.fn(() => {
        throw new Error('runtime storage not initialized');
      }),
      initializeRuntimeStorage,
      isStorageUnavailableError: vi.fn(() => false),
    }));

    try {
      await import('@core/cli/index.js');
      await storageProvider?.({
        settings: {
          storage: {
            postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
          },
        },
      } as any);
    } finally {
      if (originalGantryHome === undefined) {
        delete process.env.GANTRY_HOME;
      } else {
        process.env.GANTRY_HOME = originalGantryHome;
      }
      if (originalDatabaseUrl === undefined) {
        delete process.env.GANTRY_DATABASE_URL;
      } else {
        process.env.GANTRY_DATABASE_URL = originalDatabaseUrl;
      }
    }

    expect(initializeRuntimeStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSettings: expect.objectContaining({
          storage: {
            postgres: { urlEnv: 'GANTRY_DATABASE_URL', schema: 'gantry' },
          },
        }),
      }),
    );
    expect(initializeRuntimeStorage.mock.calls[0]?.[0]).not.toHaveProperty(
      'storageConfig',
    );
  });

  it('bypasses top-level settings validation for local status and prints Compose guidance', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'storage: nope\n',
    );
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'local', 'status']);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('docker-compose.yml'),
      'Local Status',
    );
  });

  it('lets runtime startup handle revision authority before start preflight', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      'agent:\n  name: broken\nagent:\n  name: duplicate\n',
    );
    const startGantryRuntime = vi.fn(async () => undefined);
    const validateRuntimePreflightWithStorage = vi.fn(() => {
      throw new Error('CLI start should not preflight settings.yaml directly');
    });
    vi.doMock('@core/app/index.js', () => ({ startGantryRuntime }));
    vi.doMock('@core/config/preflight.js', () => ({
      validateRuntimePreflightWithStorage,
      formatRuntimePreflightFailure: vi.fn(),
    }));
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main(['--runtime-home', runtimeHome, 'start']);

    expect(code).toBe(0);
    expect(startGantryRuntime).toHaveBeenCalledWith();
    expect(validateRuntimePreflightWithStorage).not.toHaveBeenCalled();
  });

  it('does not stop local Docker services from the Gantry CLI', async () => {
    const runtimeHome = makeRuntimeHome();
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { runLocalCommand } = await import('@core/cli/local.js');
    const code = await runLocalCommand(runtimeHome, ['stop']);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('docker compose stop'),
      'Local Stop',
    );
  });

  it('points local logs to docker compose without requiring configured services', async () => {
    const runtimeHome = makeRuntimeHome();
    const note = vi.fn();
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));

    const { runLocalCommand } = await import('@core/cli/local.js');
    const code = await runLocalCommand(runtimeHome, ['logs']);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('docker compose logs'),
      'Local Logs',
    );
  });

  it('routes top-level channel commands to the channel command family', async () => {
    const runtimeHome = makeRuntimeHome();
    const runProviderCommand = vi.fn(async () => 0);
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      configureDesiredSettingsStorageProvider: vi.fn(),
      ensureRuntimeSettings: vi.fn(),
      readRuntimeMemorySettingsSnapshot: vi.fn(() => ({
        memoryEnabled: false,
        storage: {
          postgresUrlEnv: 'GANTRY_DATABASE_URL',
          postgresSchema: 'gantry',
        },
        embeddings: {
          enabled: false,
          provider: 'disabled',
          model: 'text-embedding-3-small',
        },
        dreaming: { enabled: false },
        llmModels: {
          extractor: 'haiku',
          dreaming: 'sonnet',
          consolidation: 'sonnet',
        },
      })),
      readRuntimeStorageSettingsSnapshot: vi.fn(() => ({
        postgresUrlEnv: 'GANTRY_DATABASE_URL',
        postgresSchema: 'gantry',
      })),
    }));
    vi.doMock('@core/cli/provider.js', () => ({
      runProviderCommand: runProviderCommand,
    }));

    const { main } = await import('@core/cli/index.js');
    const code = await main([
      '--runtime-home',
      runtimeHome,
      'provider',
      'connect',
      'telegram',
    ]);

    expect(code).toBe(0);
    expect(runProviderCommand).toHaveBeenCalledWith(
      expect.any(String),
      runtimeHome,
      ['connect', 'telegram'],
    );
  });

  it('sets GANTRY_HOME from --runtime-home before lazy command imports', async () => {
    const runtimeHome = makeRuntimeHome();
    const originalGantryHome = process.env.GANTRY_HOME;
    delete process.env.GANTRY_HOME;
    const runModelCommand = vi.fn(async () => {
      expect(process.env.GANTRY_HOME).toBe(runtimeHome);
      return 0;
    });
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
      select: vi.fn(),
      text: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        message: vi.fn(),
      })),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      configureDesiredSettingsStorageProvider: vi.fn(),
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/cli/model.js', () => ({ runModelCommand }));

    try {
      const { main } = await import('@core/cli/index.js');
      const code = await main(['--runtime-home', runtimeHome, 'model', 'list']);

      expect(code).toBe(0);
      expect(runModelCommand).toHaveBeenCalledWith(runtimeHome, ['list']);
    } finally {
      if (originalGantryHome === undefined) {
        delete process.env.GANTRY_HOME;
      } else {
        process.env.GANTRY_HOME = originalGantryHome;
      }
    }
  });
});
