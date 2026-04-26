import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-preflight-'),
  );
  fs.writeFileSync(
    path.join(runtimeHome, '.env'),
    [
      'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
      'ONECLI_DATABASE_URL=postgres://onecli_app:pass@localhost:15432/myclaw?schema=onecli',
      'ONECLI_URL=http://localhost:10254',
      'SECRET_ENCRYPTION_KEY=123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(runtimeHome, 'settings.yaml'),
    [
      'channels:',
      '  telegram:',
      '    enabled: false',
      '    sender_allowlist:',
      '      default:',
      '        allow: "*"',
      '        mode: trigger',
      '      agents: {}',
      '      log_denied: true',
      '    control_allowlist:',
      '      default: []',
      '      agents: {}',
      '  slack:',
      '    enabled: false',
      '    sender_allowlist:',
      '      default:',
      '        allow: "*"',
      '        mode: trigger',
      '      agents: {}',
      '      log_denied: true',
      '    control_allowlist:',
      '      default: []',
      '      agents: {}',
      'storage:',
      '  postgres:',
      '    url_env: MYCLAW_DATABASE_URL',
      '    schema: myclaw',
      'credential_broker:',
      '  onecli:',
      '    postgres:',
      '      url_env: ONECLI_DATABASE_URL',
      '      schema: onecli',
      'memory:',
      '  enabled: true',
      '  embeddings:',
      '    enabled: false',
      '    provider: disabled',
      '    model: text-embedding-3-large',
      '  dreaming:',
      '    enabled: false',
      '  llm:',
      '    models:',
      '      extractor: claude-haiku-4-5-20251001',
      '      dreaming: claude-sonnet-4-6',
      '      consolidation: claude-sonnet-4-6',
      '',
    ].join('\n'),
  );
  return runtimeHome;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runtime preflight', () => {
  it('passes when storage and OneCLI persistence readiness pass', async () => {
    const runtimeHome = makeRuntimeHome();
    vi.doMock('@core/infrastructure/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness: vi.fn(async () => ({
            status: 'pass',
            message: 'OneCLI persistence is ready.',
          })),
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
  });

  it('fails on storage readiness before probing OneCLI persistence', async () => {
    const runtimeHome = makeRuntimeHome();
    const inspectOnecliPersistenceReadiness = vi.fn();
    vi.doMock('@core/infrastructure/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'fail',
        message: 'pgvector extension is missing.',
        details: ['vector=false'],
        nextAction: 'Enable pgvector.',
      })),
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness,
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('pgvector');
    expect(result.failure?.details.join('\n')).toContain('Enable pgvector');
    expect(inspectOnecliPersistenceReadiness).not.toHaveBeenCalled();
  });

  it('fails start readiness when OneCLI persistence isolation fails', async () => {
    const runtimeHome = makeRuntimeHome();
    vi.doMock('@core/infrastructure/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness: vi.fn(async () => ({
            status: 'fail',
            message:
              'OneCLI database role can access the MyClaw runtime schema.',
            details: ['current_user=onecli_app'],
            nextAction: 'Revoke MyClaw schema privileges.',
          })),
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('OneCLI database role');
    expect(result.failure?.details.join('\n')).toContain(
      'Revoke MyClaw schema privileges',
    );
  });

  it('allows none credential mode without OneCLI runtime secrets', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_CREDENTIAL_MODE=none',
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
    );
    const inspectOnecliPersistenceReadiness = vi.fn();
    vi.doMock('@core/infrastructure/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness,
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
    expect(inspectOnecliPersistenceReadiness).not.toHaveBeenCalled();
  });

  it('ignores stale invalid OneCLI vars outside onecli credential mode', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_CREDENTIAL_MODE=external',
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        'ANTHROPIC_BASE_URL=https://broker.example.com/anthropic',
        'ONECLI_URL=http://127.attacker.com:10254',
        'ONECLI_DATABASE_URL=not-a-postgres-url',
        'SECRET_ENCRYPTION_KEY=short',
        '',
      ].join('\n'),
    );
    vi.doMock('@core/infrastructure/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
  });

  it('fails external credential mode preflight when broker endpoint is missing', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_CREDENTIAL_MODE=external',
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
    );
    vi.doMock('@core/infrastructure/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('ANTHROPIC_BASE_URL');
  });

  it('fails external credential mode preflight when broker endpoint is unsafe', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_CREDENTIAL_MODE=external',
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        'ANTHROPIC_BASE_URL=https://user:pass@broker.example.com',
        '',
      ].join('\n'),
    );
    vi.doMock('@core/infrastructure/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('embedded credentials');
  });

  it('allows enabled channels to read credentials from process env', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      [
        'MYCLAW_CREDENTIAL_MODE=none',
        'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
        '',
      ].join('\n'),
    );
    const settingsPath = path.join(runtimeHome, 'settings.yaml');
    fs.writeFileSync(
      settingsPath,
      fs
        .readFileSync(settingsPath, 'utf-8')
        .replace(
          '  telegram:\n    enabled: false',
          '  telegram:\n    enabled: true',
        ),
    );
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'process-token');
    vi.doMock('@core/infrastructure/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
  });

  it('uses runtime-home credential mode before ambient process env', async () => {
    const runtimeHome = makeRuntimeHome();
    fs.appendFileSync(
      path.join(runtimeHome, '.env'),
      'MYCLAW_CREDENTIAL_MODE=onecli\n',
    );
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'none');
    const inspectOnecliPersistenceReadiness = vi.fn(async () => ({
      status: 'pass',
      message: 'OneCLI persistence is ready.',
    }));
    vi.doMock('@core/infrastructure/postgres/storage-readiness.js', () => ({
      inspectRuntimeStorageReadiness: vi.fn(async () => ({
        status: 'pass',
        message: 'Postgres is ready.',
      })),
    }));
    vi.doMock(
      '@core/adapters/credentials/onecli/local/persistence.js',
      async () => {
        const actual = await vi.importActual<any>(
          '@core/adapters/credentials/onecli/local/persistence.js',
        );
        return {
          ...actual,
          inspectOnecliPersistenceReadiness,
        };
      },
    );

    const { validateRuntimePreflightWithStorage } =
      await import('@core/config/preflight.js');
    const result = await validateRuntimePreflightWithStorage(runtimeHome);

    expect(result).toEqual({ ok: true });
    expect(inspectOnecliPersistenceReadiness).toHaveBeenCalled();
  });
});
