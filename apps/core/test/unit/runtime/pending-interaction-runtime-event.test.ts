import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { publishPendingInteractionRuntimeEvent } from '@core/runtime/ipc-interaction-processing.js';
import { forwardRuntimeEvents } from '@core/runtime/runtime-event-forwarding.js';

describe('pending interaction runtime events', () => {
  it('publishes the generic event after durable interaction recording', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await publishPendingInteractionRuntimeEvent(
      { publishRuntimeEvent } as never,
      {
        requestId: 'question:one',
        appId: 'app:one',
        agentId: 'agent:one',
        runId: 'run:one',
        jobId: 'job:one',
        targetJid: 'conversation:one',
        threadId: 'thread:one',
        questions: [],
      } as never,
      'question',
      'main_agent',
    );

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:one',
        agentId: 'agent:one',
        runId: 'run:one',
        jobId: 'job:one',
        conversationId: 'conversation:one',
        threadId: 'thread:one',
        eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
        correlationId: 'question:one',
        payload: {
          kind: 'question',
          requestId: 'question:one',
          sourceAgentFolder: 'main_agent',
          status: 'pending',
        },
      }),
    );
  });

  it('forwards session correlation without deduplicating distinct sessions', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await forwardRuntimeEvents({
      output: {
        status: 'success',
        result: null,
        runtimeEvents: ['session-one', 'session-two'].map((sessionId) => ({
          sessionId,
          eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
          payload: { interactionId: 'interaction-one' },
        })),
      },
      publishRuntimeEvent,
      runtimeAppId: 'app-one',
      turnAgentId: 'agent-one',
      runId: 'run-one',
      chatJid: 'conversation-one',
      sessionThreadId: null,
      forwardedKeys: new Set(),
    });

    expect(publishRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(publishRuntimeEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'session-one',
        eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
      }),
    );
    expect(publishRuntimeEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: 'session-two' }),
    );
  });

  it('adds the immutable app-turn route to caller interaction events', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await forwardRuntimeEvents({
      output: {
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
            payload: {
              interactionId: 'interaction-one',
              name: 'caller_tool',
            },
          },
        ],
      },
      publishRuntimeEvent,
      runtimeAppId: 'app-one',
      turnAgentId: 'agent-one',
      runId: 'run-one',
      chatJid: 'conversation-one',
      sessionThreadId: 'thread-one',
      turnResponseRoute: {
        sessionId: 'session-one',
        threadId: 'thread-one',
        correlationId: 'correlation-one',
        responseMode: 'webhook',
        webhookId: 'webhook-one',
      },
      forwardedKeys: new Set(),
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-one',
        runId: 'run-one',
        conversationId: 'conversation-one',
        threadId: 'thread-one',
        correlationId: 'correlation-one',
        responseMode: 'webhook',
        webhookId: 'webhook-one',
        eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
      }),
    );
  });
});
