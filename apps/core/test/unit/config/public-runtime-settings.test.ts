import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

async function loadConfigForRuntimeHome(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('MYCLAW_HOME', runtimeHome);
  return await import('@core/config/index.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('public runtime settings updates', () => {
  it('rejects patches that would enable dreaming while memory is disabled', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    const config = await loadConfigForRuntimeHome(runtimeHome);

    expect(() =>
      config.updatePublicRuntimeSettings({
        memory: { enabled: false, dreaming: { enabled: true } },
      }),
    ).toThrow('memory.dreaming.enabled requires memory.enabled=true.');

    expect(config.getPublicRuntimeSettings().memory).toEqual({
      enabled: true,
      dreaming: { enabled: false },
    });
  });

  it('rejects disabling memory when dreaming is already enabled', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    const config = await loadConfigForRuntimeHome(runtimeHome);

    config.updatePublicRuntimeSettings({
      memory: { dreaming: { enabled: true } },
    });

    expect(() =>
      config.updatePublicRuntimeSettings({
        memory: { enabled: false },
      }),
    ).toThrow('memory.dreaming.enabled requires memory.enabled=true.');

    expect(config.getPublicRuntimeSettings().memory).toEqual({
      enabled: true,
      dreaming: { enabled: true },
    });
  });

  it('redacts owner-defined browser usage override sites from public settings', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.resetModules();
    vi.stubEnv('MYCLAW_HOME', runtimeHome);
    const runtimeSettings =
      await import('@core/config/settings/runtime-settings.js');
    const defaults = runtimeSettings.ensureRuntimeSettings(runtimeHome);
    defaults.browser.usage = {
      enabled: true,
      mode: 'audit',
      windowMs: 60_000,
      maxActionsPerWindow: 100,
      maxConcurrentPerSite: 2,
      overrides: {
        'example.test': { mode: 'enforce' },
      },
    };
    runtimeSettings.saveRuntimeSettings(runtimeHome, defaults);
    const config = await import('@core/config/index.js');

    expect(config.getPublicRuntimeSettings().browser.usage).toEqual({
      enabled: true,
      mode: 'audit',
      windowMs: 60_000,
      maxActionsPerWindow: 100,
      maxConcurrentPerSite: 2,
    });
  });
});
