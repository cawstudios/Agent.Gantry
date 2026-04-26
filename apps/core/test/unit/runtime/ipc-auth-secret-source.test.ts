import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockConfigEnvModule(values: Record<string, string> = {}) {
  const readValue = (key: string) =>
    process.env[key]?.trim() || values[key]?.trim() || '';
  return {
    envConfig: values,
    envValue: readValue,
    runtimeEnvValue: readValue,
    envValueDynamic: readValue,
    runtimeEnvValueDynamic: readValue,
  };
}

describe('ipc auth secret source', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MYCLAW_IPC_AUTH_SECRET;
  });

  afterEach(() => {
    delete process.env.MYCLAW_IPC_AUTH_SECRET;
    vi.restoreAllMocks();
  });

  it('loads MYCLAW_IPC_AUTH_SECRET from .env when process env is missing', async () => {
    vi.doMock('@core/config/env/index.js', () =>
      mockConfigEnvModule({
        MYCLAW_IPC_AUTH_SECRET: 'env-file-secret',
      }),
    );
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      readRuntimeMemorySettingsSnapshot: () => ({}),
      readRuntimeStorageSettingsSnapshot: () => ({
        postgresUrlEnv: 'MYCLAW_DATABASE_URL',
        postgresSchema: 'myclaw',
      }),
    }));
    vi.doMock('@core/infrastructure/logging/logger.js', () => ({
      logger: { warn: vi.fn() },
    }));

    const { computeIpcAuthToken } = await import('@core/runtime/ipc-auth.js');
    const token = computeIpcAuthToken('team-alpha');
    const expected = createHmac('sha256', 'env-file-secret')
      .update('team-alpha')
      .digest('hex');

    expect(token).toBe(expected);
  });

  it('prefers process.env over .env secret when both are present', async () => {
    process.env.MYCLAW_IPC_AUTH_SECRET = 'process-secret';

    vi.doMock('@core/config/env/index.js', () =>
      mockConfigEnvModule({
        MYCLAW_IPC_AUTH_SECRET: 'env-file-secret',
      }),
    );
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      readRuntimeMemorySettingsSnapshot: () => ({}),
      readRuntimeStorageSettingsSnapshot: () => ({
        postgresUrlEnv: 'MYCLAW_DATABASE_URL',
        postgresSchema: 'myclaw',
      }),
    }));
    vi.doMock('@core/infrastructure/logging/logger.js', () => ({
      logger: { warn: vi.fn() },
    }));

    const { computeIpcAuthToken } = await import('@core/runtime/ipc-auth.js');
    const token = computeIpcAuthToken('team-alpha');
    const expected = createHmac('sha256', 'process-secret')
      .update('team-alpha')
      .digest('hex');

    expect(token).toBe(expected);
  });
});
