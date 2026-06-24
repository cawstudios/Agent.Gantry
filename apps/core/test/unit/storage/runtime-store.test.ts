import { afterEach, describe, expect, it, vi } from 'vitest';

function makeStorageRuntime() {
  return {
    service: {
      migrate: vi.fn(async () => {}),
      assertMigrationsCurrent: vi.fn(async () => {}),
      healthCheck: vi.fn(async () => ({
        lexicalSearch: true,
        vectorSearch: true,
        textSearch: true,
        jobQueue: true,
        runtimeEvents: true,
        eventBusOutbox: true,
      })),
      close: vi.fn(async () => {}),
    },
    ops: {},
    control: {},
    repositories: {
      workerCoordination: {},
      liveTurns: {},
    },
    runtimeEvents: {},
    runtimeEventNotifier: {
      close: vi.fn(async () => {}),
    },
    liveAdmissionWakeupSource: {
      subscribe: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    },
    fileArtifacts: {},
    skillArtifacts: {},
    browserProfileSnapshots: {},
  };
}

async function loadRuntimeStore() {
  const runtime = makeStorageRuntime();
  vi.doMock('@core/adapters/storage/postgres/factory.js', () => ({
    createStorageRuntime: vi.fn(() => runtime),
  }));
  const module =
    await import('@core/adapters/storage/postgres/runtime-store.js');
  return { module, runtime };
}

describe('initializeRuntimeStorage', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('checks migration head before checking readiness', async () => {
    const { module, runtime } = await loadRuntimeStore();

    await module.initializeRuntimeStorage();

    expect(runtime.service.migrate).not.toHaveBeenCalled();
    expect(runtime.service.assertMigrationsCurrent).toHaveBeenCalledOnce();
    expect(runtime.service.healthCheck).toHaveBeenCalledOnce();
  });
});
