import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let nextPid = 5000;
  return {
    spawn: vi.fn(() => ({
      pid: nextPid++,
      unref: vi.fn(),
    })),
    release: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('@core/runtime/browser-config.js', () => ({
  CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  DEFAULT_BROWSER_KEEPALIVE_MS: 60_000,
  DEFAULT_CHROME_ARGS: ['--no-first-run'],
}));

vi.mock('@core/runtime/browser-profiles.js', () => ({
  acquireProfileLock: vi.fn(async () => ({ release: mocks.release })),
  createProfile: vi.fn(() => ({
    name: 'myclaw',
    userDataDir: '/tmp/myclaw-browser-capability-test',
    statePath: '/tmp/myclaw-browser-capability-test/state.json',
    metadata: {
      created_at: '2026-04-29T00:00:00.000Z',
      last_used: '2026-04-29T00:00:00.000Z',
      auth_markers: [],
    },
  })),
  getProfile: vi.fn(() => null),
  updateProfileMetadata: vi.fn(),
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function cdpResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe('browser-capability', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let statSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mocks.spawn.mockClear();
    mocks.release.mockClear();
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    statSyncSpy = vi.spyOn(fs, 'statSync').mockImplementation((filePath) => {
      const value = String(filePath);
      if (value.endsWith('/Default/Cookies')) {
        return { isFile: () => true, size: 1024 } as fs.Stats;
      }
      if (value.endsWith('/Default/Login Data')) {
        return { isFile: () => true, size: 2048 } as fs.Stats;
      }
      throw new Error('missing');
    });
  });

  afterEach(async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    await manager.closeAllBrowsers();
    killSpy.mockRestore();
    existsSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('reports running only when the CDP HTTP endpoint is healthy', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    mocks.fetch
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]))
      .mockRejectedValueOnce(new Error('connection refused'));

    await manager.launchBrowser({ cdpPort: 4567 });
    const status = await manager.getBrowserStatus();

    expect(status).toEqual({
      profile: 'myclaw',
      profileName: 'myclaw',
      running: false,
      cdpReady: false,
    });
    expect(killSpy).toHaveBeenCalledWith(5000);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('relaunches instead of reusing a process with an unhealthy CDP endpoint', async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    mocks.fetch
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-1', type: 'page' }]))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(cdpResponse({ Browser: 'Chrome' }))
      .mockResolvedValueOnce(cdpResponse([{ id: 'target-2', type: 'page' }]));

    await manager.launchBrowser({ cdpPort: 4567 });
    const relaunched = await manager.launchBrowser({ cdpPort: 4568 });

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(5001);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(relaunched).toMatchObject({
      running: true,
      port: 4568,
      targetId: 'target-2',
    });
  });

  it('reports persistent state when Chrome cookie or login stores exist', async () => {
    const manager = await import('@core/runtime/browser-capability.js');

    await expect(manager.listBrowserProfiles()).resolves.toEqual([
      {
        name: 'myclaw',
        created_at: '2026-04-29T00:00:00.000Z',
        last_used: '2026-04-29T00:00:00.000Z',
        cdp_port: undefined,
        auth_markers: ['cookies', 'login-data'],
        has_state: true,
        running: false,
        cdpReady: false,
      },
    ]);
  });
});
