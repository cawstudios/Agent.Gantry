import { describe, expect, it, vi } from 'vitest';

import { SessionInteractionModule } from '@core/application/sessions/session-interaction-module.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

function makeModule(overrides?: {
  control?: Record<string, unknown>;
  ops?: Record<string, unknown>;
  repositories?: Record<string, unknown>;
  runtimeEvents?: Record<string, unknown>;
  liveAdmissionAppId?: string | null;
  getConfiguredAgentRuntime?: (
    agentFolder: string,
  ) => 'worker' | 'inline' | undefined;
}) {
  const control = {
    ensureAppSession: vi.fn(async (input) => ({
      sessionId: 'session-1',
      appId: input.appId,
      agentId: input.agentId ?? null,
      conversationId: input.conversationId,
      conversationJid: input.conversationJid,
      workspaceKey: input.folder,
      defaultResponseMode: input.defaultResponseMode ?? 'sse',
      defaultWebhookId: input.defaultWebhookId ?? null,
    })),
    getWebhookById: vi.fn(),
    getAppSessionById: vi.fn(async () => ({
      sessionId: 'session-1',
      appId: 'app-one',
      agentId: 'agent:tender-folder',
      conversationId: 'conv-1',
      conversationJid: 'app:app-one:conv-1',
      workspaceKey: 'group',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    })),
    upsertAppResponseRoute: vi.fn(async () => ({
      responseMode: 'sse',
      webhookId: null,
      correlationId: null,
    })),
    getAppSessionByChatJid: vi.fn(),
    getAppResponseRoute: vi.fn(),
    ...overrides?.control,
  };
  const runtimeEvents = {
    publish: vi.fn(async () => ({ eventId: 1001 })),
    list: vi.fn(async () => []),
    subscribe: vi.fn(async () => ({
      next: vi.fn(async () => []),
      close: vi.fn(),
    })),
    ...overrides?.runtimeEvents,
  };
  const ops = {
    storeChatMetadata: vi.fn(async () => undefined),
    storeMessage: vi.fn(async () => undefined),
    getMessageThreadIds: vi.fn(async () => [null]),
    ...overrides?.ops,
  };
  const repositories = {
    agents: {
      getAgent: vi.fn(),
      listAgents: vi.fn(async () => []),
    },
    agentSessions: {
      getAgentSession: vi.fn(async () => ({
        id: 'session-1',
        appId: 'app-one',
        agentId: 'agent:tender-folder',
        conversationId: 'conv-1',
        status: 'active',
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt: '2026-04-30T00:00:00.000Z',
      })),
      saveAgentSession: vi.fn(async () => undefined),
    },
    providerSessions: {
      getLatestProviderSession: vi.fn(async () => null),
      markProviderSessionStatus: vi.fn(async () => undefined),
    },
    messages: {},
    agentRuns: {},
    ...overrides?.repositories,
  };
  const module = new SessionInteractionModule({
    control: control as never,
    ops: ops as never,
    repositories: repositories as never,
    runtimeEvents: runtimeEvents as never,
    liveAdmissionAppId: overrides?.liveAdmissionAppId,
    getConfiguredAgentRuntime:
      overrides?.getConfiguredAgentRuntime ?? vi.fn(() => 'inline'),
    now: () => '2026-04-30T00:00:00.000Z' as never,
    createId: () => 'id-1',
    stableHash: () => '123456789abc',
  });
  return { module, control, ops, repositories, runtimeEvents };
}

describe('SessionInteractionModule', () => {
  it('binds a named app agent and returns its canonical execution context', async () => {
    const { module, control } = makeModule({
      repositories: {
        agents: {
          listAgents: vi.fn(async () => [
            {
              id: 'agent:tender-folder',
              appId: 'app-one',
              name: 'Tender Agent',
              status: 'active',
            },
          ]),
        },
      },
    });

    const result = await module.ensureSession({
      appId: 'app-one',
      conversationId: 'conv-1',
      agentName: 'Tender Agent',
    });

    expect(control.ensureAppSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:tender-folder',
        folder: 'tender-folder',
      }),
    );
    expect(result.session).toMatchObject({
      sessionId: 'session-1',
      conversationJid: 'app:app-one:conv-1',
      workspaceKey: 'tender-folder',
    });
  });

  it('generates valid bounded workspace folders for long app sessions', async () => {
    const { module, control } = makeModule();

    await module.ensureSession({
      appId: 'a'.repeat(64),
      conversationId: 'b'.repeat(64),
    });

    expect(control.ensureAppSession).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: expect.stringMatching(/^app_123456789abc_/),
      }),
    );
    const [{ folder }] = control.ensureAppSession.mock.calls[0]!;
    expect(folder).toHaveLength(64);
  });

  it('rejects non-canonical conversation ids before creating app chat ids', async () => {
    const { module, control } = makeModule();

    await expect(
      module.ensureSession({
        appId: 'app-one',
        conversationId: 'bad:conversation',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message:
        'appId and conversationId must contain only letters, numbers, dot, underscore, or dash',
    });
    expect(control.ensureAppSession).not.toHaveBeenCalled();
  });

  it('rejects waits for sessions outside the authenticated app', async () => {
    const { module, runtimeEvents } = makeModule({
      control: {
        getAppSessionById: vi.fn(async () => ({
          sessionId: 'session-1',
          appId: 'app-two',
          conversationId: 'conv-1',
          conversationJid: 'app:app-two:conv-1',
          workspaceKey: 'group',
          defaultResponseMode: 'sse',
          defaultWebhookId: null,
        })),
      },
    });

    await expect(
      module.waitForVisibleEvent({
        appId: 'app-one',
        sessionId: 'session-1',
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'API key cannot access this session',
    });
    expect(runtimeEvents.subscribe).not.toHaveBeenCalled();
  });

  it('redacts provider session identifiers from default session details', async () => {
    const { module } = makeModule({
      repositories: {
        agentSessions: {
          getAgentSession: vi.fn(async () => ({
            id: 'session-1',
            appId: 'app-one',
            agentId: 'agent-one',
            conversationId: 'conv-1',
            status: 'active',
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          })),
        },
        providerSessions: {
          getLatestProviderSession: vi.fn(async () => ({
            id: 'provider-session-sdk-resume-handle',
            appId: 'app-one',
            agentSessionId: 'session-1',
            provider: 'anthropic',
            externalSessionId: 'claude-session-secret',
            providerRef: {
              kind: 'provider_session',
              value: 'anthropic:claude-session-secret',
            },
            status: 'active',
            metadata: { resumeHandle: 'claude-session-secret' },
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          })),
        },
      },
    });

    const details = (await module.getSessionDetails({
      appId: 'app-one',
      sessionId: 'session-1',
    })) as { providerSession: Record<string, unknown> | null };

    expect(details.providerSession).toMatchObject({
      provider: 'anthropic',
      status: 'active',
      hasProviderResume: true,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    expect(details.providerSession).not.toHaveProperty('id');
    expect(details.providerSession).not.toHaveProperty('appId');
    expect(details.providerSession).not.toHaveProperty('agentSessionId');
    expect(details.providerSession).not.toHaveProperty('externalSessionId');
    expect(details.providerSession).not.toHaveProperty('providerRef');
    expect(details.providerSession).not.toHaveProperty('metadata');
  });

  it('stores accepted SDK messages with durable live admission work', async () => {
    const order: string[] = [];
    const publish = vi.fn();
    const upsertAppResponseRoute = vi.fn();
    const publishWithLiveAdmissionMessage = vi.fn(async (event, admission) => {
      order.push('publishAcceptedEventAndStoreAdmission');
      expect(event).toMatchObject({
        conversationId: 'app:app-one:conv-1',
        threadId: 'thread-1',
      });
      expect(admission).toMatchObject({
        message: {
          chat_jid: 'app:app-one:conv-1',
          content: 'hello from sdk',
          responseSchema: {
            type: 'object',
            required: ['answer'],
          },
          agentControls: {
            effort: 'high',
            thinking: { mode: 'on', budgetTokens: 1024 },
            maxOutputTokens: 4096,
          },
          appResponseRoute: {
            sessionId: 'session-1',
            threadId: 'thread-1',
            responseMode: 'webhook',
            webhookId: null,
            correlationId: 'corr-1',
          },
        },
        liveAdmission: {
          appId: 'app-one',
          agentId: 'agent:tender-folder',
          agentSessionId: 'session-1',
          sdkSessionAdmissionRequest: {
            requestMessageId: expect.any(String),
            idempotencyKey: 'teams-activity-1',
            requestFingerprint: '123456789abc',
            queuePolicy: {
              maxWaitingMessages: 3,
              maxQueueWaitMs: 90_000,
              executionTimeoutMs: 90_000,
            },
          },
          triggerDecision: {
            source: 'sdk_session',
            responseMode: 'webhook',
          },
          now: '2026-04-30T00:00:00.000Z',
        },
      });
      return {
        outcome: 'accepted',
        event: { eventId: 1001 },
        liveAdmissionResult: {
          outcome: 'enqueued',
          item: { id: 'admission-1', state: 'queued' },
        },
      };
    });
    const { module, ops } = makeModule({
      control: {
        upsertAppResponseRoute,
      },
      ops: {
        notifyLiveAdmissionWorkItem: vi.fn(async () => {
          order.push('notifyLiveAdmissionWorkItem');
        }),
      },
      runtimeEvents: {
        publish,
        publishWithLiveAdmissionMessage,
      },
    });

    const accepted = await module.acceptMessage({
      appId: 'app-one',
      sessionId: 'session-1',
      idempotencyKey: 'teams-activity-1',
      queuePolicy: {
        maxWaitingMessages: 3,
        maxQueueWaitMs: 90_000,
        executionTimeoutMs: 90_000,
      },
      message: 'hello from sdk',
      threadId: 'thread-1',
      responseMode: 'webhook',
      senderId: 'user-1',
      senderName: 'User One',
      correlationId: 'corr-1',
      responseSchema: {
        type: 'object',
        required: ['answer'],
      },
      agentControls: {
        effort: 'high',
        thinking: { mode: 'on', budgetTokens: 1024 },
        maxOutputTokens: 4096,
      },
      beforeDurableAdmission: async () => {
        order.push('beforeDurableAdmission');
      },
    });

    expect(order).toEqual([
      'beforeDurableAdmission',
      'publishAcceptedEventAndStoreAdmission',
      'notifyLiveAdmissionWorkItem',
    ]);
    expect(upsertAppResponseRoute).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(ops.storeMessage).not.toHaveBeenCalled();
    expect(accepted.enqueue).toEqual({
      conversationJid: 'app:app-one:conv-1',
      threadId: 'thread-1',
      queueKey: 'app:app-one:conv-1::thread:thread-1',
      durableAdmissionCreated: true,
    });
    expect(accepted.replayed).toBe(false);
  });

  it('returns the original SDK receipt without notifying or enqueueing an exact replay', async () => {
    const notifyLiveAdmissionWorkItem = vi.fn();
    const { module, ops } = makeModule({
      ops: { notifyLiveAdmissionWorkItem },
      runtimeEvents: {
        publishWithLiveAdmissionMessage: vi.fn(async () => ({
          outcome: 'replayed',
          messageId: 'original-message',
          acceptedEventId: 77,
        })),
      },
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        idempotencyKey: 'same-request',
        queuePolicy: {
          maxWaitingMessages: 3,
          maxQueueWaitMs: 90_000,
          executionTimeoutMs: 90_000,
        },
        message: 'hello from sdk',
      }),
    ).resolves.toMatchObject({
      accepted: true,
      replayed: true,
      messageId: 'original-message',
      acceptedEventId: 77,
      enqueue: { durableAdmissionCreated: true },
    });
    expect(ops.storeMessage).not.toHaveBeenCalled();
    expect(notifyLiveAdmissionWorkItem).not.toHaveBeenCalled();
  });

  it.each([
    ['fingerprint_conflict', 'SESSION_IDEMPOTENCY_CONFLICT'],
    ['capacity_exceeded', 'SESSION_QUEUE_FULL'],
  ] as const)(
    'fails SDK admission outcome %s with stable code %s',
    async (outcome, code) => {
      const { module } = makeModule({
        runtimeEvents: {
          publishWithLiveAdmissionMessage: vi.fn(async () =>
            outcome === 'capacity_exceeded'
              ? { outcome, activeAndWaiting: 4, capacity: 4 }
              : { outcome },
          ),
        },
      });

      await expect(
        module.acceptMessage({
          appId: 'app-one',
          sessionId: 'session-1',
          idempotencyKey: 'same-request',
          queuePolicy: {
            maxWaitingMessages: 3,
            maxQueueWaitMs: 90_000,
            executionTimeoutMs: 90_000,
          },
          message: 'hello from sdk',
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it('accepts and persists response schemas for worker runtimes', async () => {
    const getConfiguredAgentRuntime = vi.fn(() => 'worker' as const);
    const { module, ops } = makeModule({
      getConfiguredAgentRuntime,
      liveAdmissionAppId: null,
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'hello from sdk',
        responseSchema: { type: 'object' },
      }),
    ).resolves.toMatchObject({ accepted: true });

    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ responseSchema: { type: 'object' } }),
    );
  });

  it('persists explicit bounded continuity on the accepted message', async () => {
    const { module, ops } = makeModule({ liveAdmissionAppId: null });

    await module.acceptMessage({
      appId: 'app-one',
      sessionId: 'session-1',
      message: 'bounded turn',
      continuityMode: 'bounded',
    });

    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ continuityMode: 'bounded' }),
    );
  });

  it('archives the session and expires its provider continuity idempotently', async () => {
    const saveAgentSession = vi.fn(async () => undefined);
    const markProviderSessionStatus = vi.fn(async () => undefined);
    const { module } = makeModule({
      ops: {
        getMessageThreadIds: vi.fn(async () => [null, 'thread-one']),
      },
      repositories: {
        agentSessions: {
          getAgentSession: vi.fn(async () => ({
            id: 'session-1',
            appId: 'app-one',
            agentId: 'agent:tender-folder',
            conversationId: 'conv-1',
            status: 'active',
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          })),
          saveAgentSession,
        },
        providerSessions: {
          getLatestProviderSession: vi.fn(async () => ({
            id: 'provider-session-1',
            agentSessionId: 'session-1',
            status: 'active',
          })),
          markProviderSessionStatus,
        },
      },
    });

    await expect(
      module.archiveSession({ appId: 'app-one', sessionId: 'session-1' }),
    ).resolves.toMatchObject({
      archived: true,
      alreadyArchived: false,
      queueKeys: [
        'app:app-one:conv-1',
        'app:app-one:conv-1::thread:thread-one',
      ],
    });
    expect(saveAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'archived' }),
    );
    expect(markProviderSessionStatus).toHaveBeenCalledWith(
      'provider-session-1',
      'expired',
      '2026-04-30T00:00:00.000Z',
    );
  });

  it('rejects new turns for archived sessions', async () => {
    const { module, ops } = makeModule({
      repositories: {
        agentSessions: {
          getAgentSession: vi.fn(async () => ({
            id: 'session-1',
            status: 'archived',
          })),
          saveAgentSession: vi.fn(),
        },
      },
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'late message',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Session is archived',
    });
    expect(ops.storeMessage).not.toHaveBeenCalled();
  });

  it('accepts response schemas when no settings agent entry resolves', async () => {
    const getConfiguredAgentRuntime = vi.fn(() => undefined);
    const { module, ops } = makeModule({
      getConfiguredAgentRuntime,
      liveAdmissionAppId: null,
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'hello from sdk',
        responseSchema: { type: 'object' },
      }),
    ).resolves.toMatchObject({ accepted: true });

    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ responseSchema: { type: 'object' } }),
    );
  });

  it('accepts and persists response schemas for inline runtimes', async () => {
    const getConfiguredAgentRuntime = vi.fn(() => 'inline' as const);
    const { module, ops } = makeModule({
      getConfiguredAgentRuntime,
      liveAdmissionAppId: null,
    });

    await expect(
      module.acceptMessage({
        appId: 'app-one',
        sessionId: 'session-1',
        message: 'hello from sdk',
        responseSchema: { type: 'object' },
      }),
    ).resolves.toMatchObject({ accepted: true });

    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        responseSchema: { type: 'object' },
      }),
    );
  });

  it('falls back to plain message storage when durable live admission is disabled', async () => {
    const storeMessageWithLiveAdmission = vi.fn(async () => ({
      outcome: 'enqueued',
      item: {},
    }));
    const { module, ops } = makeModule({
      liveAdmissionAppId: null,
      ops: { storeMessageWithLiveAdmission },
    });

    const accepted = await module.acceptMessage({
      appId: 'app-one',
      sessionId: 'session-1',
      message: 'hello from sdk',
      responseSchema: { type: 'object' },
    });

    expect(storeMessageWithLiveAdmission).not.toHaveBeenCalled();
    expect(ops.storeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'hello from sdk',
        responseSchema: { type: 'object' },
      }),
    );
    expect(accepted.enqueue.durableAdmissionCreated).toBe(false);
  });

  it('summarizes provider resume state without exposing raw metadata handles', async () => {
    const { module } = makeModule({
      repositories: {
        agentSessions: {
          getAgentSession: vi.fn(async () => ({
            id: 'session-1',
            appId: 'app-one',
            agentId: 'agent-one',
            conversationId: 'conv-1',
            status: 'active',
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          })),
        },
        providerSessions: {
          getLatestProviderSession: vi.fn(async () => ({
            id: 'provider-session-opaque',
            appId: 'app-one',
            agentSessionId: 'session-1',
            provider: 'anthropic',
            externalSessionId: '',
            providerRef: {
              kind: 'provider_session',
              value: '',
            },
            status: 'active',
            metadata: {
              resume: {
                session_id: 'short-handle-from-metadata',
              },
            },
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          })),
        },
      },
    });

    const details = (await module.getSessionDetails({
      appId: 'app-one',
      sessionId: 'session-1',
    })) as { providerSession: Record<string, unknown> | null };

    expect(details.providerSession).toMatchObject({
      provider: 'anthropic',
      status: 'active',
      hasProviderResume: true,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    expect(JSON.stringify(details.providerSession)).not.toContain(
      'short-handle-from-metadata',
    );
    expect(details.providerSession).not.toHaveProperty('externalSessionId');
    expect(details.providerSession).not.toHaveProperty('providerRef');
    expect(details.providerSession).not.toHaveProperty('metadata');
  });

  it('times out session waits and closes the subscription', async () => {
    const close = vi.fn();
    const next = vi.fn(async () => []);
    const { module, runtimeEvents } = makeModule({
      runtimeEvents: {
        subscribe: vi.fn(async () => ({ next, close })),
      },
    });

    await expect(
      module.waitForVisibleEvent({
        appId: 'app-one',
        sessionId: 'session-1',
        afterEventId: 9,
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({
      code: 'WAIT_TIMEOUT',
      message: 'Timed out waiting for session event',
    });
    expect(runtimeEvents.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-one',
        sessionId: 'session-1',
        afterEventId: 9,
      }),
    );
    expect(next).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('publishes the run and immutable response route selected for the turn', async () => {
    const route = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      responseMode: 'webhook' as const,
      webhookId: 'webhook-1',
      correlationId: 'correlation-1',
    };
    const getAppResponseRoute = vi.fn();
    const publish = vi.fn(async () => ({ eventId: 1002 }));
    const { module } = makeModule({
      control: {
        getAppSessionByChatJid: vi.fn(async () => ({
          sessionId: 'session-1',
          appId: 'app-one',
          conversationJid: 'app:app-one:conv-1',
          defaultResponseMode: 'sse',
          defaultWebhookId: null,
        })),
        getAppResponseRoute,
      },
      runtimeEvents: { publish },
    });

    await module.publishOutboundEvent({
      conversationJid: 'app:app-one:conv-1',
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING,
      payload: { text: 'answer', threadId: 'thread-1' },
      runId: 'run-1',
      appResponseRoute: route,
    });

    expect(getAppResponseRoute).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING,
        sessionId: 'session-1',
        runId: 'run-1',
        threadId: 'thread-1',
        correlationId: 'correlation-1',
        responseMode: 'webhook',
        webhookId: 'webhook-1',
      }),
    );
  });
});
