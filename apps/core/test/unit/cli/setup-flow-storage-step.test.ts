import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-storage-step-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

async function loadStorageStepWithPrompts(responses: unknown[]) {
  const select = vi.fn(async () => responses.shift());
  const text = vi.fn(async () => responses.shift());
  const note = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    select,
    text,
    note,
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    })),
  }));
  const { runStorageStep } = await import('@core/cli/setup-flow-core-steps.js');
  const { restoreDraft } = await import('@core/cli/setup-flow-state.js');
  return { runStorageStep, restoreDraft, select, text, note };
}

describe('setup storage step', () => {
  it('collects local database URLs without provisioning Docker', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runStorageStep, restoreDraft, text } =
      await loadStorageStepWithPrompts([
        'local',
        'postgres://myclaw_app:pass@localhost:5432/myclaw',
        'myclaw',
        'onecli',
        'postgres://onecli_app:pass@localhost:5432/myclaw?schema=onecli',
      ]);
    const draft = restoreDraft(runtimeHome, null);

    const action = await runStorageStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.postgresSetupKind).toBe('local');
    expect(draft.postgresDatabaseUrl).toBe(
      'postgres://myclaw_app:pass@localhost:5432/myclaw',
    );
    expect(draft.onecliPostgresDatabaseUrl).toContain('onecli_app');
    expect(text).toHaveBeenCalledTimes(4);
    expect(fs.existsSync(path.join(runtimeHome, '.env'))).toBe(false);
    expect(
      fs.existsSync(path.join(runtimeHome, 'data', 'local-postgres.json')),
    ).toBe(false);
  });

  it('requires SSL for hosted Postgres URLs', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runStorageStep, restoreDraft } = await loadStorageStepWithPrompts([
      'hosted',
      'postgres://user:pass@db.example.com:5432/myclaw',
    ]);
    const draft = restoreDraft(runtimeHome, null);

    await expect(runStorageStep(draft)).rejects.toThrow(/sslmode=require/);
  });

  it('allows localhost for the existing Postgres expert path', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runStorageStep, restoreDraft } = await loadStorageStepWithPrompts([
      'existing',
      'postgres://user:pass@localhost:5432/myclaw',
      'custom_schema',
      'agent_vault',
      'postgres://onecli:pass@localhost:5432/myclaw?schema=agent_vault',
    ]);
    const draft = restoreDraft(runtimeHome, null);

    const action = await runStorageStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.postgresSetupKind).toBe('existing');
    expect(draft.postgresDatabaseUrl).toBe(
      'postgres://user:pass@localhost:5432/myclaw',
    );
    expect(draft.onecliPostgresDatabaseUrl).toBe(
      'postgres://onecli:pass@localhost:5432/myclaw?schema=agent_vault',
    );
    expect(draft.postgresSchema).toBe('custom_schema');
    expect(draft.onecliPostgresSchema).toBe('agent_vault');
  });

  it('rejects hosted and existing OneCLI URLs that reuse the MyClaw role', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runStorageStep, restoreDraft } = await loadStorageStepWithPrompts([
      'existing',
      'postgres://user:pass@localhost:5432/myclaw',
      'myclaw',
      'onecli',
      'postgres://user:pass@localhost:5432/myclaw?schema=onecli',
    ]);
    const draft = restoreDraft(runtimeHome, null);

    await expect(runStorageStep(draft)).rejects.toThrow(
      /different Postgres roles/,
    );
  });

  it('rejects hosted and existing OneCLI URLs that point at a different database', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runStorageStep, restoreDraft } = await loadStorageStepWithPrompts([
      'existing',
      'postgres://myclaw:pass@localhost:5432/myclaw',
      'myclaw',
      'onecli',
      'postgres://onecli:pass@localhost:5432/other?schema=onecli',
    ]);
    const draft = restoreDraft(runtimeHome, null);

    await expect(runStorageStep(draft)).rejects.toThrow(
      /same Postgres database/,
    );
  });
});
