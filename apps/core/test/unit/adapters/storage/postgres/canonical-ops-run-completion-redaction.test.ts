import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAgentRun, saveAgentRun, getAgentSession } = vi.hoisted(() => ({
  getAgentRun: vi.fn(),
  saveAgentRun: vi.fn(),
  getAgentSession: vi.fn(),
}));

vi.mock(
  '@core/adapters/storage/postgres/repositories/domain-repositories.postgres.js',
  () => ({
    createPostgresDomainRepositories: vi.fn(() => ({
      agentRuns: {
        getAgentRun,
        saveAgentRun,
      },
      agentSessions: { getAgentSession },
      agentSessionDigests: {},
    })),
  }),
);

import { PostgresRuntimeRepositoryBundle } from '@core/adapters/storage/postgres/schema/canonical-ops-repo.postgres.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

describe('PostgresRuntimeRepositoryBundle run completion redaction', () => {
  beforeEach(() => {
    getAgentRun.mockReset();
    saveAgentRun.mockReset();
    getAgentSession.mockReset();
  });

  it('publishes message-owned correlation when a live app run starts', async () => {
    const publish = vi.fn(async () => undefined);
    getAgentSession.mockResolvedValue({
      id: 'agent-session:test',
      appId: 'app:test',
      agentId: 'agent:test',
      conversationId: 'conversation:test',
      threadId: 'canonical-thread:test',
    } as never);
    const bundle = new PostgresRuntimeRepositoryBundle(
      { end: vi.fn(async () => undefined) } as never,
      {} as never,
      { runtimeEvents: { publish } },
    );

    const runId = await bundle.createSessionAgentRun({
      agentSessionId: 'agent-session:test',
      executionProviderId: 'anthropic:claude-agent-sdk',
      messageId: 'message:test',
      appResponseRoute: {
        sessionId: 'agent-session:test',
        threadId: 'thread:test',
        correlationId: 'correlation:test',
        responseMode: 'webhook',
        webhookId: 'webhook:test',
      },
      cause: 'message',
    });

    expect(runId).toMatch(/^agent-run:/);
    expect(saveAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: runId,
        sessionId: 'agent-session:test',
        messageId: 'message:test',
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        sessionId: 'agent-session:test',
        conversationId: 'conversation:test',
        threadId: 'thread:test',
        correlationId: 'correlation:test',
        responseMode: 'webhook',
        webhookId: 'webhook:test',
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTED,
        payload: expect.objectContaining({ messageId: 'message:test' }),
      }),
    );
  });

  it('redacts provider resume handles before storing and publishing completion summaries', async () => {
    const publish = vi.fn(async () => undefined);
    getAgentRun.mockResolvedValue({
      id: 'run-1',
      appId: 'app:test',
      sessionId: 'agent-session:test',
      conversationId: 'conversation:test',
      threadId: 'canonical-thread:test',
      messageId: 'message:test',
      status: 'running',
    } as never);

    const bundle = new PostgresRuntimeRepositoryBundle(
      { end: vi.fn(async () => undefined) } as never,
      {} as never,
      { runtimeEvents: { publish } },
    );

    await bundle.completeSessionAgentRun({
      runId: 'run-1',
      status: 'failed',
      appResponseRoute: {
        sessionId: 'agent-session:test',
        threadId: 'thread:test',
        correlationId: 'correlation:test',
        responseMode: 'webhook',
        webhookId: 'webhook:test',
      },
      resultSummary:
        '{"newSessionId":"json-new-handle"} sessionId=session-inline-handle',
      errorSummary:
        'boom provider-session:shape-secret claude-session-shape-secret',
    });

    expect(saveAgentRun).toHaveBeenCalledTimes(1);
    const savedRun = saveAgentRun.mock.calls[0][0];
    expect(savedRun.resultSummary).toContain('[REDACTED]');
    expect(savedRun.errorSummary).toContain('[REDACTED]');
    expect(savedRun.resultSummary).not.toContain('json-new-handle');
    expect(savedRun.resultSummary).not.toContain('session-inline-handle');
    expect(savedRun.errorSummary).not.toContain(
      'provider-session:shape-secret',
    );
    expect(savedRun.errorSummary).not.toContain('claude-session-shape-secret');

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0][0];
    expect(event.eventType).toBe(RUNTIME_EVENT_TYPES.RUN_FAILED);
    expect(event).toMatchObject({
      sessionId: 'agent-session:test',
      conversationId: 'conversation:test',
      threadId: 'thread:test',
      correlationId: 'correlation:test',
      responseMode: 'webhook',
      webhookId: 'webhook:test',
    });
    expect(event.payload.messageId).toBe('message:test');
    expect(event.payload.resultSummary).toContain('[REDACTED]');
    expect(event.payload.errorSummary).toContain('[REDACTED]');
    expect(event.payload.resultSummary).not.toContain('json-new-handle');
    expect(event.payload.resultSummary).not.toContain('session-inline-handle');
    expect(event.payload.errorSummary).not.toContain(
      'provider-session:shape-secret',
    );
    expect(event.payload.errorSummary).not.toContain(
      'claude-session-shape-secret',
    );
  });
});
