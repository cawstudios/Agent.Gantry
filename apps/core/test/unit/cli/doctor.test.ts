import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

function makeRuntimeHome(envLines: string[] = []): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-doctor-'));
  runtimeHomes.push(runtimeHome);
  fs.writeFileSync(path.join(runtimeHome, '.env'), `${envLines.join('\n')}\n`);
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

async function loadDoctor(options?: {
  onecliEnv?: Record<string, string>;
  onecliPersistence?: { status: string; message: string };
}) {
  const getContainerConfig = vi.fn(async () => ({
    env: options?.onecliEnv || {},
  }));
  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: vi.fn(function () {
      return { getContainerConfig };
    }),
  }));
  vi.doMock('@core/infrastructure/service/package-paths.js', () => ({
    assertRuntimeEntryExists: vi.fn(),
    getRuntimeEntryPath: () => '/mock/dist/index.js',
  }));
  vi.doMock('@core/infrastructure/service/platform.js', () => ({
    commandExists: vi.fn(() => true),
    detectPlatform: vi.fn(() => 'macos'),
    getNodeMajorVersion: vi.fn(() => 25),
    getNodeVersion: vi.fn(() => '25.0.0'),
    hasSystemdUser: vi.fn(() => false),
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
        inspectOnecliPersistenceReadiness: vi.fn(async () => ({
          status: options?.onecliPersistence?.status || 'pass',
          message: options?.onecliPersistence?.message || 'OneCLI ready.',
        })),
      };
    },
  );
  return import('@core/cli/doctor.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('doctor', () => {
  it('fails external model access when the broker endpoint is missing', async () => {
    const runtimeHome = makeRuntimeHome([
      'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
      'MYCLAW_CREDENTIAL_MODE=external',
    ]);
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'fail',
      message: 'External credential mode requires ANTHROPIC_BASE_URL.',
      nextAction: expect.stringContaining('ANTHROPIC_BASE_URL'),
    });
  });

  it('prioritizes external broker checks over stale OneCLI URL env', async () => {
    const runtimeHome = makeRuntimeHome([
      'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
      'MYCLAW_CREDENTIAL_MODE=external',
      'ONECLI_URL=http://localhost:10254',
    ]);
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'fail',
      message: 'External credential mode requires ANTHROPIC_BASE_URL.',
      nextAction: expect.stringContaining('ANTHROPIC_BASE_URL'),
    });
  });

  it('fails external model access when the broker endpoint URL is unsafe', async () => {
    const runtimeHome = makeRuntimeHome([
      'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
      'MYCLAW_CREDENTIAL_MODE=external',
      'ANTHROPIC_BASE_URL=https://user:pass@broker.example.com',
    ]);
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'fail',
      message: 'ANTHROPIC_BASE_URL must not contain embedded credentials.',
      nextAction: expect.stringContaining('HTTPS broker URL'),
    });
  });

  it('passes external model access when the broker endpoint is safe', async () => {
    const runtimeHome = makeRuntimeHome([
      'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
      'MYCLAW_CREDENTIAL_MODE=external',
      'ANTHROPIC_BASE_URL=https://broker.example.com/anthropic',
    ]);
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'pass',
      message: 'Model Access is managed by external credential mode.',
    });
  });

  it('uses runtime-home broker endpoint before ambient process env in doctor', async () => {
    vi.stubEnv(
      'ANTHROPIC_BASE_URL',
      'https://user:pass@ambient-broker.example.com/anthropic',
    );
    const runtimeHome = makeRuntimeHome([
      'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
      'MYCLAW_CREDENTIAL_MODE=external',
      'ANTHROPIC_BASE_URL=https://broker.example.com/anthropic',
    ]);
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find((entry) => entry.id === 'claude-broker');

    expect(check).toMatchObject({
      status: 'pass',
      message: 'Model Access is managed by external credential mode.',
    });
  });

  it('reports missing OneCLI database configuration with a concrete next action', async () => {
    const runtimeHome = makeRuntimeHome([
      'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
      'ONECLI_URL=http://localhost:10254',
    ]);
    const { runDoctor } = await loadDoctor();

    const report = runDoctor(import.meta.url, runtimeHome);
    const check = report.checks.find(
      (entry) => entry.id === 'onecli-persistence-config',
    );

    expect(check).toMatchObject({
      status: 'fail',
      message: 'ONECLI_DATABASE_URL is missing.',
    });
    expect(check?.nextAction).toContain('schema=onecli');
  });

  it('fails reachability when OneCLI returns forbidden database secrets', async () => {
    const runtimeHome = makeRuntimeHome([
      'MYCLAW_DATABASE_URL=postgres://myclaw_app:pass@localhost:15432/myclaw',
      'ONECLI_DATABASE_URL=postgres://onecli_app:pass@localhost:15432/myclaw?schema=onecli',
      'ONECLI_URL=http://localhost:10254',
      'SECRET_ENCRYPTION_KEY=123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    ]);
    const { runDoctorWithNetwork } = await loadDoctor({
      onecliEnv: { POSTGRES_PASSWORD: 'secret' },
    });

    const report = await runDoctorWithNetwork(import.meta.url, runtimeHome, {
      validateTelegramToken: false,
    });
    const check = report.checks.find(
      (entry) => entry.id === 'onecli-reachability',
    );

    expect(check).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('POSTGRES_PASSWORD'),
    });
  });
});
