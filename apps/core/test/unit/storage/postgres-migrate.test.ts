import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const migrateMock = vi.hoisted(() => vi.fn(async () => undefined));
const closeMock = vi.hoisted(() => vi.fn(async () => undefined));
const serviceCtorMock = vi.hoisted(() =>
  vi.fn(function PostgresStorageServiceMock() {
    return {
      migrate: migrateMock,
      close: closeMock,
    };
  }),
);

vi.mock('@core/adapters/storage/postgres/storage-service.js', () => ({
  PostgresStorageService: serviceCtorMock,
}));

vi.mock('@core/adapters/storage/postgres/url.js', () => ({
  fleetRehearsalPlaintextPostgresHosts: vi.fn(() => ['postgres']),
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  migrateMock.mockClear();
  closeMock.mockClear();
  serviceCtorMock.mockClear();
  vi.resetModules();
});

describe('postgres migration entrypoint', () => {
  it('requires GANTRY_DATABASE_URL', async () => {
    delete process.env.GANTRY_DATABASE_URL;
    const { resolvePostgresMigrateConfig } =
      await import('@core/postgres-migrate.js');

    expect(() => resolvePostgresMigrateConfig()).toThrow(
      /GANTRY_DATABASE_URL is required/,
    );
  });

  it('resolves schema from env before url and default', async () => {
    process.env.GANTRY_DATABASE_URL =
      'postgres://user:pass@127.0.0.1:5432/gantry?schema=url_schema';
    process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA = 'env_schema';
    const { resolvePostgresMigrateConfig } =
      await import('@core/postgres-migrate.js');

    expect(resolvePostgresMigrateConfig()).toEqual({
      url: process.env.GANTRY_DATABASE_URL,
      schema: 'env_schema',
    });
  });

  it('reads GANTRY_DATABASE_URL from runtime home env file', async () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-home-'));
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'GANTRY_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/gantry?schema=file_schema\n',
      'utf-8',
    );
    delete process.env.GANTRY_DATABASE_URL;
    process.env.GANTRY_HOME = runtimeHome;
    const { resolvePostgresMigrateConfig } =
      await import('@core/postgres-migrate.js');

    expect(resolvePostgresMigrateConfig()).toEqual({
      url: 'postgres://user:pass@127.0.0.1:5432/gantry?schema=file_schema',
      schema: 'file_schema',
    });
  });

  it('runs migrations and closes storage', async () => {
    const { runPostgresMigrations } = await import('@core/postgres-migrate.js');

    await runPostgresMigrations({
      url: 'postgres://user:pass@127.0.0.1:5432/gantry',
      schema: 'gantry',
    });

    expect(serviceCtorMock).toHaveBeenCalledWith(
      'postgres://user:pass@127.0.0.1:5432/gantry',
      'gantry',
      { plaintextHostAllowlist: ['postgres'] },
    );
    expect(migrateMock).toHaveBeenCalledOnce();
    expect(closeMock).toHaveBeenCalledOnce();
  });
});
