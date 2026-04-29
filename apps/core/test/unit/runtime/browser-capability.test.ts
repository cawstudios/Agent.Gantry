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

vi.mock('@core/runtime/browser-profiles.js', () => ({
  acquireProfileLock: vi.fn(async () => ({ release: mocks.release })),
  createProfile: vi.fn(() => ({
    name: 'myclaw',
    userDataDir: '/tmp/myclaw-browser-capability-test',
    metadata: {},
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

  beforeEach(() => {
    vi.resetModules();
    mocks.spawn.mockClear();
    mocks.release.mockClear();
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(async () => {
    const manager = await import('@core/runtime/browser-capability.js');
    await manager.closeAllBrowsers();
    killSpy.mockRestore();
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
});
