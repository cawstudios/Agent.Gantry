import { describe, expect, it, vi } from 'vitest';

import type { ConversationRoute } from '@core/domain/types.js';
import type { WarmPoolRuntime } from '@core/runtime/agent-spawn-types.js';

function makeGroup(
  overrides: Partial<ConversationRoute> = {},
): ConversationRoute {
  return {
    name: 'Default Agent',
    folder: 'main_agent',
    trigger: '@main',
    added_at: '2026-04-24T09:00:00.000Z',
    requiresTrigger: false,
    ...overrides,
  };
}

async function loadRuntimeApp() {
  vi.resetModules();
  vi.doMock('@core/config/index.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@core/config/index.js')>();
    return {
      ...actual,
      ASSISTANT_NAME: 'Default Agent',
      DATA_DIR: '/tmp/gantry-test',
      GANTRY_IPC_AUTH_SECRET: 'runtime-app-test-secret',
      getCredentialBrokerRuntimeConfig: () => ({
        mode: 'gantry',
        model_gatewayUrl: 'http://localhost:10254',
        externalBrokerBaseUrl: undefined,
      }),
    };
  });
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeRepositories: vi.fn(() => {
      throw new Error('ops repository should not be used by this test');
    }),
    getRuntimeSkillArtifactStore: vi.fn(),
    getRuntimeStorage: vi.fn(),
  }));
  return import('@core/app/bootstrap/runtime-app.js');
}

async function loadRuntimeAppWithGroupProcessorSpy() {
  vi.resetModules();
  const runClaudeQuery = vi.fn(async () => '{"action":"allow","reason":"ok"}');
  const createGroupProcessor = vi.fn(() => ({
    processGroupMessages: vi.fn(async () => true),
  }));
  vi.doMock('@core/config/index.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@core/config/index.js')>();
    return {
      ...actual,
      ASSISTANT_NAME: 'Default Agent',
      DATA_DIR: '/tmp/gantry-test',
      GANTRY_IPC_AUTH_SECRET: 'runtime-app-test-secret',
      getCredentialBrokerRuntimeConfig: () => ({
        mode: 'gantry',
        model_gatewayUrl: 'http://localhost:10254',
        externalBrokerBaseUrl: undefined,
      }),
    };
  });
  vi.doMock('@core/runtime/group-processing.js', () => ({
    createGroupProcessor,
  }));
  vi.doMock(
    '@core/adapters/llm/anthropic-claude-agent/memory-query.js',
    async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import('@core/adapters/llm/anthropic-claude-agent/memory-query.js')
        >();
      return { ...actual, runClaudeQuery };
    },
  );
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeRepositories: vi.fn(() => {
      throw new Error('ops repository should not be used by this test');
    }),
    getRuntimeSkillArtifactStore: vi.fn(),
    getRuntimeStorage: vi.fn(),
  }));
  const runtimeApp = await import('@core/app/bootstrap/runtime-app.js');
  return { ...runtimeApp, createGroupProcessor, runClaudeQuery };
}

describe('runtime app credential binding', () => {
  it('ensures shared Model Access once and agent-scoped tool profiles for registered groups', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const firstGroup = makeGroup();
    const sideGroup = makeGroup({
      name: 'Side Agent',
      folder: 'side_agent',
    });
    const ensureCredentialBinding = vi.fn(async () => ({ created: true }));
    const app = createRuntimeApp({ ensureCredentialBinding });

    app.setConversationRoutesForTest({
      'tg:first': firstGroup,
      'tg:second': sideGroup,
    });

    await app.ensureCredentialBindingsForConversationRoutes();
    await app.ensureCredentialBindingsForConversationRoutes();

    expect(ensureCredentialBinding).toHaveBeenCalledTimes(3);
    expect(ensureCredentialBinding).toHaveBeenCalledWith({
      groupJid: 'tg:first',
      group: firstGroup,
      agentIdentifier: 'gantry-model-access',
      agentName: 'Gantry Model Access',
    });
    expect(ensureCredentialBinding).toHaveBeenCalledWith({
      groupJid: 'tg:first',
      group: firstGroup,
      agentIdentifier: 'agent:main_agent',
      agentName: 'Default Agent',
    });
    expect(ensureCredentialBinding).toHaveBeenCalledWith({
      groupJid: 'tg:second',
      group: sideGroup,
      agentIdentifier: 'agent:side_agent',
      agentName: 'Side Agent',
    });
  });

  it('retries a failed credential profile ensure attempt', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const group = makeGroup();
    const ensureCredentialBinding = vi
      .fn()
      .mockRejectedValueOnce(new Error('Gantry Model Gateway starting'))
      .mockResolvedValueOnce({ created: false });
    const app = createRuntimeApp({ ensureCredentialBinding });

    app.setConversationRoutesForTest({ 'tg:first': group });

    await app.ensureCredentialBindingsForConversationRoutes();
    await app.ensureCredentialBindingsForConversationRoutes();

    expect(ensureCredentialBinding).toHaveBeenCalledTimes(3);
    expect(ensureCredentialBinding.mock.calls.map(([input]) => input)).toEqual([
      {
        groupJid: 'tg:first',
        group,
        agentIdentifier: 'gantry-model-access',
        agentName: 'Gantry Model Access',
      },
      {
        groupJid: 'tg:first',
        group,
        agentIdentifier: 'agent:main_agent',
        agentName: 'Default Agent',
      },
      {
        groupJid: 'tg:first',
        group,
        agentIdentifier: 'gantry-model-access',
        agentName: 'Gantry Model Access',
      },
    ]);
  });

  it('delegates provider-visible streaming support to channel runtime', async () => {
    const { createRuntimeApp, createGroupProcessor } =
      await loadRuntimeAppWithGroupProcessorSpy();
    const app = createRuntimeApp();
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];
    expect(capturedDeps).toBeDefined();

    app.setChannelRuntime({
      hasChannel: vi.fn(() => true),
      supportsStreaming: vi.fn(() => true),
      supportsProgress: vi.fn(() => false),
      sendMessage: vi.fn(async () => {}),
      sendStreamingChunk: vi.fn(async () => true),
      resetStreaming: vi.fn(),
      setTyping: vi.fn(async () => {}),
      sendProgressUpdate: vi.fn(async () => {}),
    });

    expect(capturedDeps?.channelRuntime.supportsStreaming('tg:primary')).toBe(
      true,
    );
  });

  it('wires queue continuation delivery into group processing', async () => {
    const { createRuntimeApp, createGroupProcessor } =
      await loadRuntimeAppWithGroupProcessorSpy();
    createRuntimeApp();
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];

    expect(capturedDeps?.queue.sendMessage).toEqual(expect.any(Function));
    expect(capturedDeps?.queue.sendMessage?.('tg:primary', 'follow up')).toBe(
      false,
    );
  });

  it('wires a default no-tools guardrail classifier into group processing', async () => {
    const { createRuntimeApp, createGroupProcessor, runClaudeQuery } =
      await loadRuntimeAppWithGroupProcessorSpy();
    createRuntimeApp();
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];
    expect(capturedDeps?.guardrailClassifier).toBeDefined();

    await expect(
      capturedDeps!.guardrailClassifier!({
        policy: 'bss_customer_support',
        model: 'haiku',
        messages: ['Can you help?'],
        prompt: 'classify',
      }),
    ).resolves.toEqual({ action: 'allow', reason: 'ok' });
    expect(runClaudeQuery).toHaveBeenCalledWith({
      appId: 'default',
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'classify',
      disableTools: true,
      prompt: JSON.stringify(
        {
          policy: 'bss_customer_support',
          messages: ['Can you help?'],
        },
        null,
        2,
      ),
    });
  });

  it('wires the warm pool runtime into group processing when provided', async () => {
    const { createRuntimeApp, createGroupProcessor } =
      await loadRuntimeAppWithGroupProcessorSpy();
    const warmPool: WarmPoolRuntime = {
      acquire: vi.fn(() => null),
      release: vi.fn(async () => undefined),
    };

    const app = createRuntimeApp({ warmPool });
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];

    expect(app.warmPool).toBe(warmPool);
    expect(capturedDeps?.warmPool).toBe(warmPool);
  });

  it('composes a local worker inventory snapshot from warm pool and queue state', async () => {
    const { createRuntimeApp } = await loadRuntimeAppWithGroupProcessorSpy();
    const warmPool: WarmPoolRuntime = {
      acquire: vi.fn(() => null),
      inventory: vi.fn(() => ({
        availableTarget: 2,
        genericAvailable: 1,
        genericStarting: 1,
        boundActive: 3,
        boundIdle: 0,
        boundDraining: 0,
        maxBoundWorkers: 4,
        cachePrewarm: {
          pending: 0,
          succeeded: 1,
          skipped: 0,
          failed: 0,
        },
        cacheShapes: [
          {
            cacheShapeKey: 'shape:test',
            status: 'succeeded',
            workers: 1,
          },
        ],
      })),
      release: vi.fn(async () => undefined),
    };
    const app = createRuntimeApp({
      warmPool,
      runtimeInstanceId: 'runtime:test',
      runtimeHostname: 'test-host',
      runtimeStartedAt: new Date('2026-06-17T00:00:00.000Z'),
    });

    expect(
      app.getWorkerInventorySnapshot(new Date('2026-06-17T00:00:05.000Z')),
    ).toEqual({
      instanceId: 'runtime:test',
      hostname: 'test-host',
      startedAt: '2026-06-17T00:00:00.000Z',
      lastHeartbeatAt: '2026-06-17T00:00:05.000Z',
      warmPool: {
        availableTarget: 2,
        genericAvailable: 1,
        genericStarting: 1,
        boundActive: 3,
        boundIdle: 0,
        boundDraining: 0,
        maxBoundWorkers: 4,
        cachePrewarm: {
          pending: 0,
          succeeded: 1,
          skipped: 0,
          failed: 0,
        },
        cacheShapes: [
          {
            cacheShapeKey: 'shape:test',
            status: 'succeeded',
            workers: 1,
          },
        ],
      },
      queue: {
        activeMessageRuns: 0,
        pendingConversationKeys: 0,
        maxMessageRuns: 3,
      },
    });
  });

  it('wires the ownership token resolver into group processing when provided', async () => {
    const { createRuntimeApp, createGroupProcessor } =
      await loadRuntimeAppWithGroupProcessorSpy();
    const getMessageSendOwnershipToken = vi.fn();

    createRuntimeApp({ getMessageSendOwnershipToken });
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];

    expect(capturedDeps?.getMessageSendOwnershipToken).toBe(
      getMessageSendOwnershipToken,
    );
  });

  it('exposes the ownership token resolver for runtime services', async () => {
    const { createRuntimeApp } = await loadRuntimeAppWithGroupProcessorSpy();
    const ownershipToken = {
      appId: 'default',
      conversationId: 'wa:918097570111',
      threadId: null,
      ownerInstanceId: 'runtime:test',
      leaseVersion: 3,
    };
    const getMessageSendOwnershipToken = vi.fn(async () => ownershipToken);
    const app = createRuntimeApp({ getMessageSendOwnershipToken });

    await expect(
      app.getMessageSendOwnershipToken({
        conversationId: 'wa:918097570111',
        threadId: null,
      }),
    ).resolves.toEqual(ownershipToken);
    expect(getMessageSendOwnershipToken).toHaveBeenCalledWith({
      conversationId: 'wa:918097570111',
      threadId: null,
    });
  });
});
