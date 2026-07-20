import { describe, expect, it, vi } from 'vitest';

import {
  buildLiveAdmissionProcessor,
  startLiveExecutionServices,
} from '@core/app/bootstrap/live-execution.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

describe('startLiveExecutionServices', () => {
  it('creates a live run with the selected canonical message and immutable response route', async () => {
    const queueJid = makeAgentThreadQueueKey('app:tenant:chat', 'agent:alpha');
    const appResponseRoute = {
      sessionId: 'session-app',
      threadId: null,
      responseMode: 'sse' as const,
      webhookId: null,
      correlationId: 'correlation-1',
    };
    const createSessionAgentRun = vi.fn(async () => 'run-app');
    const admit = vi.fn(async () => ({
      outcome: 'claimed' as const,
      fence: {
        leaseToken: 'lease-app',
        workerInstanceId: 'worker-app',
        fencingVersion: 1,
      },
    }));
    const processor = buildLiveAdmissionProcessor({
      liveTurnAuthority: {
        ownedRunId: vi.fn(),
        ownedFence: vi.fn(),
        ownsQueue: vi.fn(() => false),
        getActiveLiveTurn: vi.fn(async () => undefined),
        admit,
        finalize: vi.fn(async () => true),
        registerStopAliases: vi.fn(async () => undefined),
        routeMessage: vi.fn(),
      } as any,
      app: {
        getConversationRoutes: () => ({
          [queueJid]: { folder: 'alpha', conversationKind: 'dm' },
        }),
        processGroupMessages: vi.fn(async () => true),
        getOrRecoverCursor: vi.fn(async () => ''),
        setAgentCursor: vi.fn(),
        saveState: vi.fn(),
      },
      opsRepository: {
        getAgentTurnContext: vi.fn(async () => ({
          appId: 'tenant',
          agentSessionId: 'session-app',
        })),
        getMessagesSince: vi.fn(async () => [
          {
            id: 'provider-message-1',
            canonicalMessageId: 'message:canonical:1',
            chat_jid: 'app:tenant:chat',
            sender: 'user-1',
            sender_name: 'User',
            content: 'hello',
            timestamp: '2026-07-20T00:00:00.000Z',
            appResponseRoute,
          },
        ]),
        createSessionAgentRun,
      },
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      messageFetchPageSize: 50,
      maxMessagesPerPrompt: 10,
      timezone: 'UTC',
      enqueueMessageCheck: vi.fn(),
      warn: vi.fn(),
    });

    await expect(processor(queueJid)).resolves.toBe(true);
    expect(createSessionAgentRun).toHaveBeenCalledWith({
      agentSessionId: 'session-app',
      executionProviderId: 'anthropic:claude-agent-sdk',
      providerSessionId: undefined,
      messageId: 'message:canonical:1',
      appResponseRoute,
      cause: 'message',
    });
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-app',
        pendingMessage: expect.objectContaining({
          messageId: 'message:canonical:1',
          appResponseRoute,
        }),
      }),
    );
  });

  it('rejects an expired SDK queue entry before creating a model run', async () => {
    const queueJid = makeAgentThreadQueueKey('app:tenant:chat', 'agent:alpha');
    const createSessionAgentRun = vi.fn(async () => 'run-should-not-exist');
    const setAgentCursor = vi.fn();
    const enqueueMessageCheck = vi.fn();
    const message = {
      id: 'provider-message-expired',
      canonicalMessageId: 'message:canonical:expired',
      chat_jid: 'app:tenant:chat',
      sender: 'user-1',
      sender_name: 'User',
      content: 'expired question',
      timestamp: '2026-07-20T00:00:00.000Z',
      appResponseRoute: {
        sessionId: 'session-app',
        threadId: null,
        responseMode: 'sse' as const,
        webhookId: null,
        correlationId: 'correlation-expired',
      },
    };
    const prepareSdkSessionTurn = vi.fn(async () => ({
      turnState: 'timed_out',
      terminalCode: 'queue_wait_timeout',
    }));
    const processGroupMessages = vi.fn(async () => true);
    const processor = buildLiveAdmissionProcessor({
      liveTurnAuthority: {
        ownedRunId: vi.fn(),
        ownedFence: vi.fn(),
        ownsQueue: vi.fn(() => false),
        getActiveLiveTurn: vi.fn(async () => undefined),
        prepareSdkSessionTurn,
      } as any,
      app: {
        getConversationRoutes: () => ({
          [queueJid]: { folder: 'alpha', conversationKind: 'dm' },
        }),
        processGroupMessages,
        getOrRecoverCursor: vi.fn(async () => ''),
        setAgentCursor,
        saveState: vi.fn(),
      },
      opsRepository: {
        getAgentTurnContext: vi.fn(async () => ({
          appId: 'tenant',
          agentSessionId: 'session-app',
        })),
        getMessagesSince: vi.fn(async () => [message]),
        createSessionAgentRun,
      },
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      messageFetchPageSize: 50,
      maxMessagesPerPrompt: 10,
      timezone: 'UTC',
      enqueueMessageCheck,
      warn: vi.fn(),
    });

    await expect(processor(queueJid)).resolves.toBe(true);
    expect(prepareSdkSessionTurn).toHaveBeenCalledWith(
      'message:canonical:expired',
    );
    expect(createSessionAgentRun).not.toHaveBeenCalled();
    expect(processGroupMessages).not.toHaveBeenCalled();
    expect(setAgentCursor).toHaveBeenCalledWith(queueJid, expect.any(String));
    expect(enqueueMessageCheck).toHaveBeenCalledWith(queueJid);
  });

  it('passes the remaining SDK deadline and terminal-marks a typed timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
    try {
      const queueJid = makeAgentThreadQueueKey(
        'app:tenant:chat',
        'agent:alpha',
      );
      const message = {
        id: 'provider-message-timeout',
        canonicalMessageId: 'message:canonical:timeout',
        chat_jid: 'app:tenant:chat',
        sender: 'user-1',
        sender_name: 'User',
        content: 'slow question',
        timestamp: '2026-07-20T00:00:00.000Z',
        appResponseRoute: {
          sessionId: 'session-app',
          threadId: null,
          responseMode: 'sse' as const,
          webhookId: null,
          correlationId: 'correlation-timeout',
        },
      };
      const finalize = vi.fn(async () => true);
      const processGroupMessages = vi.fn(async (_queueJid, options) => {
        options.onRunResult?.('timed_out');
        return false;
      });
      const getMessagesSince = vi.fn(async () => [message]);
      const processor = buildLiveAdmissionProcessor({
        liveTurnAuthority: {
          ownedRunId: vi.fn(),
          ownedFence: vi.fn(),
          ownsQueue: vi.fn(() => false),
          getActiveLiveTurn: vi.fn(async () => undefined),
          prepareSdkSessionTurn: vi.fn(async () => ({
            turnState: 'waiting',
          })),
          beginSdkSessionTurn: vi.fn(async () => ({
            turnState: 'running',
            executionDeadlineAt: '2026-07-20T00:01:30.000Z',
          })),
          admit: vi.fn(async () => ({
            outcome: 'claimed',
            fence: {
              leaseToken: 'lease-timeout',
              workerInstanceId: 'worker-timeout',
              fencingVersion: 1,
            },
          })),
          finalize,
          registerStopAliases: vi.fn(async () => undefined),
          routeMessage: vi.fn(),
        } as any,
        app: {
          getConversationRoutes: () => ({
            [queueJid]: { folder: 'alpha', conversationKind: 'dm' },
          }),
          processGroupMessages,
          getOrRecoverCursor: vi.fn(async () => ''),
          setAgentCursor: vi.fn(),
          saveState: vi.fn(),
        },
        opsRepository: {
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'tenant',
            agentSessionId: 'session-app',
          })),
          getMessagesSince,
          createSessionAgentRun: vi.fn(async () => 'run-timeout'),
        },
        executionAdapter: { id: 'anthropic:claude-agent-sdk' },
        messageFetchPageSize: 50,
        maxMessagesPerPrompt: 10,
        timezone: 'UTC',
        enqueueMessageCheck: vi.fn(),
        warn: vi.fn(),
      });

      await expect(processor(queueJid)).resolves.toBe(true);
      expect(processGroupMessages).toHaveBeenCalledWith(
        queueJid,
        expect.objectContaining({
          timeoutMs: 90_000,
          executionDeadlineAtMs: Date.parse('2026-07-20T00:01:30.000Z'),
          finalRetry: true,
        }),
      );
      expect(finalize).toHaveBeenCalledWith(
        queueJid,
        'timed_out',
        expect.objectContaining({
          status: 'failed',
          errorSummary: 'Live turn exceeded its execution deadline.',
        }),
      );
      expect(getMessagesSince).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the exact thread route when admitting a live queue', async () => {
    const queueJid = makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1');
    const getAgentTurnContext = vi.fn(async () => ({
      appId: 'default',
      agentSessionId: 'session-thread',
    }));
    const resolveExecutionProviderId = vi.fn(() => 'deepagents:langchain');
    const processor = buildLiveAdmissionProcessor({
      liveTurnAuthority: {
        ownedRunId: vi.fn(),
        ownedFence: vi.fn(),
        ownsQueue: vi.fn(() => false),
        getActiveLiveTurn: vi.fn(async () => undefined),
        admit: vi.fn(async () => ({
          outcome: 'claimed',
          fence: {
            leaseToken: 'lease-1',
            workerInstanceId: 'worker-1',
            fencingVersion: 1,
          },
        })),
        finalize: vi.fn(async () => true),
        registerStopAliases: vi.fn(async () => undefined),
        routeMessage: vi.fn(),
      } as any,
      app: {
        getConversationRoutes: () => ({
          [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: {
            folder: 'alpha',
            conversationKind: 'channel',
          },
          [queueJid]: {
            folder: 'alpha',
            conversationKind: 'dm',
            agentConfig: { model: 'gpt-5.5' },
          },
        }),
        processGroupMessages: vi.fn(async () => true),
        getOrRecoverCursor: vi.fn(async () => ''),
        setAgentCursor: vi.fn(),
        saveState: vi.fn(),
        resolveExecutionProviderId,
      },
      opsRepository: {
        getAgentTurnContext,
        createSessionAgentRun: vi.fn(async () => 'run-1'),
      },
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      messageFetchPageSize: 50,
      timezone: 'UTC',
      enqueueMessageCheck: vi.fn(),
      warn: vi.fn(),
    });

    await expect(processor(queueJid)).resolves.toBe(true);
    expect(getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKind: 'dm',
        executionProviderId: 'deepagents:langchain',
        threadId: 'T1',
      }),
    );
    expect(resolveExecutionProviderId).toHaveBeenCalledWith(
      expect.objectContaining({ agentConfig: { model: 'gpt-5.5' } }),
      'sl:C123',
    );
  });

  it('scopes live admission session lookup to the provider account', async () => {
    const queueJid = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:alpha',
      null,
      'slack-workspace-2',
    );
    const getAgentTurnContext = vi.fn(async () => ({
      appId: 'default',
      agentSessionId: 'session-workspace-2',
    }));
    const processor = buildLiveAdmissionProcessor({
      liveTurnAuthority: {
        ownedRunId: vi.fn(),
        ownedFence: vi.fn(),
        ownsQueue: vi.fn(() => false),
        getActiveLiveTurn: vi.fn(async () => undefined),
        admit: vi.fn(async () => ({
          outcome: 'claimed',
          fence: {
            leaseToken: 'lease-1',
            workerInstanceId: 'worker-1',
            fencingVersion: 1,
          },
        })),
        finalize: vi.fn(async () => true),
        registerStopAliases: vi.fn(async () => undefined),
        routeMessage: vi.fn(),
      } as any,
      app: {
        getConversationRoutes: () => ({
          [queueJid]: {
            folder: 'alpha',
            conversationKind: 'channel',
          },
        }),
        processGroupMessages: vi.fn(async () => true),
        getOrRecoverCursor: vi.fn(async () => ''),
        setAgentCursor: vi.fn(),
        saveState: vi.fn(),
      },
      opsRepository: {
        getAgentTurnContext,
        createSessionAgentRun: vi.fn(async () => 'run-1'),
      },
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      messageFetchPageSize: 50,
      timezone: 'UTC',
      enqueueMessageCheck: vi.fn(),
      warn: vi.fn(),
    });

    await expect(processor(queueJid)).resolves.toBe(true);
    expect(getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: 'slack-workspace-2' }),
    );
  });

  it('does not retry a terminally acknowledged failed turn', async () => {
    const queueJid = makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1');
    const finalize = vi.fn(async () => true);
    const processor = buildLiveAdmissionProcessor({
      liveTurnAuthority: {
        ownedRunId: vi.fn(),
        ownedFence: vi.fn(),
        ownsQueue: vi.fn(() => false),
        getActiveLiveTurn: vi.fn(async () => undefined),
        admit: vi.fn(async () => ({
          outcome: 'claimed',
          fence: {
            leaseToken: 'lease-1',
            workerInstanceId: 'worker-1',
            fencingVersion: 1,
          },
        })),
        finalize,
        registerStopAliases: vi.fn(async () => undefined),
        routeMessage: vi.fn(),
      } as any,
      app: {
        getConversationRoutes: () => ({
          [queueJid]: {
            folder: 'alpha',
            conversationKind: 'channel',
          },
        }),
        processGroupMessages: vi.fn(async (_queueJid, options) => {
          options.onRunResult?.('error');
          return true;
        }),
        getOrRecoverCursor: vi.fn(async () => ''),
        setAgentCursor: vi.fn(),
        saveState: vi.fn(),
      },
      opsRepository: {
        getAgentTurnContext: vi.fn(async () => ({
          appId: 'default',
          agentSessionId: 'session-thread',
        })),
        createSessionAgentRun: vi.fn(async () => 'run-1'),
      },
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      messageFetchPageSize: 50,
      timezone: 'UTC',
      enqueueMessageCheck: vi.fn(),
      warn: vi.fn(),
    });

    await expect(processor(queueJid, { finalRetry: true })).resolves.toBe(true);
    expect(finalize).toHaveBeenCalledWith(
      queueJid,
      'failed',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('does not admit a top-level live queue through a thread-only route', async () => {
    const getAgentTurnContext = vi.fn();
    const processor = buildLiveAdmissionProcessor({
      liveTurnAuthority: {
        ownedRunId: vi.fn(),
        ownedFence: vi.fn(),
        ownsQueue: vi.fn(() => false),
      } as any,
      app: {
        getConversationRoutes: () => ({
          [makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1')]: {
            folder: 'alpha',
            conversationKind: 'channel',
          },
        }),
        processGroupMessages: vi.fn(async () => true),
        getOrRecoverCursor: vi.fn(async () => ''),
        setAgentCursor: vi.fn(),
        saveState: vi.fn(),
      },
      opsRepository: { getAgentTurnContext },
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      messageFetchPageSize: 50,
      timezone: 'UTC',
      enqueueMessageCheck: vi.fn(),
      warn: vi.fn(),
    });

    await expect(
      processor(makeAgentThreadQueueKey('sl:C123', 'agent:alpha')),
    ).resolves.toBe(false);
    expect(getAgentTurnContext).not.toHaveBeenCalled();
  });

  it('uses durable live admission claims instead of route-wide scans', () => {
    const admissionStop = vi.fn();
    const admissionTrigger = vi.fn();
    const startLiveAdmissionWorkLoop = vi.fn(() => ({
      stop: admissionStop,
      trigger: admissionTrigger,
      done: new Promise<void>(() => {}),
    }));
    const registeredLoops: unknown[] = [];
    let subscribedWake: (() => void) | undefined;
    const unsubscribeWake = vi.fn();

    const handle = startLiveExecutionServices({
      app: {
        getConversationRoutes: vi.fn(() => ({})),
        processGroupMessages: vi.fn(),
        getOrRecoverCursor: vi.fn(),
        setAgentCursor: vi.fn(),
        saveState: vi.fn(),
        queue: {
          getPolicy: vi.fn(() => ({ maxMessageRuns: 3, maxRetries: 7 })),
          enqueueMessageCheck: vi.fn(() => true),
        },
      } as any,
      appId: 'default',
      liveTurnAuthority: undefined,
      liveTurnLeaseDeps: {
        liveTurns: {
          claimLiveAdmissionWorkItems: vi.fn(),
          renewLiveAdmissionWorkItemClaim: vi.fn(),
          deferLiveAdmissionWorkItem: vi.fn(),
          settleLiveAdmissionWorkItem: vi.fn(),
        },
        coordination: {},
        workerInstanceId: 'worker-1',
      } as any,
      messageLoopDeps: {} as any,
      recoveryCoordinator: {
        onTransition: vi.fn(),
      },
      isEligibleToRecoverLiveTurn: vi.fn(),
      alertNoEligibleLiveTurnRecoverer: undefined,
      recoverPendingMessages: vi.fn(),
      startLiveAdmissionWorkLoop,
      liveAdmissionWakeupSource: {
        subscribe: vi.fn((listener: () => void) => {
          subscribedWake = listener;
          return unsubscribeWake;
        }),
        close: vi.fn(),
      },
      registerActiveAdmissionLoop: (loop) => {
        registeredLoops.push(loop);
      },
      registerActiveRecoveryLoop: vi.fn(),
      onPollingCrash: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(startLiveAdmissionWorkLoop).toHaveBeenCalledOnce();
    expect(startLiveAdmissionWorkLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        maxRetryCount: 7,
      }),
    );
    expect(registeredLoops).toHaveLength(1);

    subscribedWake?.();
    expect(admissionTrigger).toHaveBeenCalledOnce();

    handle.stopAdmission();
    expect(unsubscribeWake).toHaveBeenCalledOnce();
    expect(admissionStop).toHaveBeenCalledOnce();
    expect(registeredLoops).toHaveLength(2);
    expect(registeredLoops[1]).toBeUndefined();
  });

  it('does not start live admission without durable claims', () => {
    const warn = vi.fn();

    const handle = startLiveExecutionServices({
      app: {
        getConversationRoutes: vi.fn(() => ({})),
        processGroupMessages: vi.fn(),
        getOrRecoverCursor: vi.fn(),
        setAgentCursor: vi.fn(),
        saveState: vi.fn(),
        queue: {
          getPolicy: vi.fn(() => ({ maxMessageRuns: 3, maxRetries: 7 })),
          enqueueMessageCheck: vi.fn(() => true),
        },
      } as any,
      appId: 'default',
      liveTurnAuthority: undefined,
      liveTurnLeaseDeps: undefined,
      messageLoopDeps: {} as any,
      recoveryCoordinator: undefined,
      isEligibleToRecoverLiveTurn: vi.fn(),
      alertNoEligibleLiveTurnRecoverer: undefined,
      recoverPendingMessages: vi.fn(),
      registerActiveAdmissionLoop: vi.fn(),
      registerActiveRecoveryLoop: vi.fn(),
      onPollingCrash: vi.fn(),
      info: vi.fn(),
      warn,
    });

    expect(handle.admissionLoop).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { processRole: undefined },
      'Live admission requires durable admission claims; live admission disabled for this role',
    );
  });
});
