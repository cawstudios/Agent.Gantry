import { describe, expect, it, vi } from 'vitest';

import { runStartup } from '@core/app/bootstrap/startup.js';
import { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';

function makeApp(overrides: Partial<RuntimeApp> = {}): RuntimeApp {
  return {
    channels: [],
    queue: {} as RuntimeApp['queue'],
    loadState: vi.fn(async () => {}),
    saveState: vi.fn(async () => {}),
    getOrRecoverCursor: vi.fn(async () => ''),
    registerGroup: vi.fn(async () => {}),
    setGroupModelOverride: vi.fn(async () => {}),
    setGroupThinkingOverride: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(() => []),
    setRegisteredGroupsForTest: vi.fn(),
    ensureOneCLIAgentsForRegisteredGroups: vi.fn(),
    clearSessionForChatJid: vi.fn(async () => {}),
    processGroupMessages: vi.fn(),
    getRegisteredGroups: vi.fn(() => ({})),
    getLastTimestamp: vi.fn(() => ''),
    setLastTimestamp: vi.fn(),
    setAgentCursor: vi.fn(),
    setChannelRuntime: vi.fn(),
    ...overrides,
  };
}

describe('runStartup', () => {
  it('preserves startup order through host runtime startup', async () => {
    const order: string[] = [];
    const app = makeApp({
      loadState: vi.fn(() => {
        order.push('load-state');
      }),
      ensureOneCLIAgentsForRegisteredGroups: vi.fn(() => {
        order.push('ensure-onecli');
      }),
    });

    const runtimeSettings = {
      channels: {},
      storage: {
        postgres: { urlEnv: 'MYCLAW_DATABASE_URL', schema: 'myclaw' },
      },
      memory: {},
    } as any;
    const result = await runStartup(app, {
      ensureRuntimeLayoutDirectories: vi.fn(() => {
        order.push('layout');
      }),
      ensurePromptProfileBootstrapped: vi.fn(() => {
        order.push('prompt-bootstrap');
      }),
      initializeRuntimeStorage: vi.fn(async () => {
        order.push('init-storage');
        return {} as any;
      }),
      logger: {
        info: vi.fn(() => {
          order.push('log-db-init');
        }),
        warn: vi.fn(),
      },
      loadRuntimeSettings: vi.fn(() => {
        order.push('load-settings');
        return runtimeSettings;
      }),
      restoreRemoteControl: vi.fn(() => {
        order.push('restore-remote-control');
      }),
    });

    expect(order).toEqual([
      'layout',
      'prompt-bootstrap',
      'load-settings',
      'init-storage',
      'log-db-init',
      'load-state',
      'ensure-onecli',
      'restore-remote-control',
    ]);
    expect(result.runtimeSettings).toBe(runtimeSettings);
  });

  it('continues startup when prompt bootstrap fails', async () => {
    const order: string[] = [];
    const warn = vi.fn();

    await runStartup(makeApp(), {
      ensureRuntimeLayoutDirectories: vi.fn(() => {
        order.push('layout');
      }),
      ensurePromptProfileBootstrapped: vi.fn(() => {
        throw new Error('seed failed');
      }),
      initializeRuntimeStorage: vi.fn(async () => {
        order.push('init-storage');
        return {} as any;
      }),
      loadRuntimeSettings: vi.fn(
        () =>
          ({
            channels: {},
            storage: {
              postgres: { urlEnv: 'MYCLAW_DATABASE_URL', schema: 'myclaw' },
            },
            memory: {},
          }) as any,
      ),
      restoreRemoteControl: vi.fn(() => {
        order.push('restore-remote-control');
      }),
      logger: {
        info: vi.fn(),
        warn,
      },
    });

    expect(order).toEqual(['layout', 'init-storage', 'restore-remote-control']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('initializes Postgres storage for runtime settings', async () => {
    const initializeRuntimeStorage = vi.fn(async () => ({}) as any);
    await runStartup(makeApp(), {
      ensureRuntimeLayoutDirectories: vi.fn(),
      ensurePromptProfileBootstrapped: vi.fn(),
      initializeRuntimeStorage,
      loadRuntimeSettings: vi.fn(
        () =>
          ({
            channels: {},
            storage: { provider: 'postgres' },
            memory: {},
          }) as any,
      ),
      restoreRemoteControl: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(initializeRuntimeStorage).toHaveBeenCalledOnce();
  });
});
