import { describe, expect, it, vi } from 'vitest';

import type { AsyncTaskRecord } from '@core/domain/ports/async-tasks.js';
import { createSessionCompactionHandlers } from '@core/runtime/group-session-command-state.js';

function task(patch: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    id: 'task-1',
    appId: 'default',
    agentId: 'agent-1',
    conversationId: 'chat-1',
    threadId: null,
    parentRunId: null,
    parentJobId: null,
    parentJobRunId: null,
    kind: 'session_compaction',
    status: 'completed',
    admissionClass: 'task',
    authoritySnapshotJson: {},
    privateCorrelationJson: {},
    leaseToken: 'lease-1',
    fencingVersion: 1,
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:01:00.000Z',
    outputSummary: 'ready',
    ...patch,
  };
}

function handlers(input: {
  context?: Record<string, unknown>;
  tasks?: AsyncTaskRecord[];
}) {
  const repository = {
    listTasks: vi.fn(async () => input.tasks ?? []),
    transitionTask: vi.fn(async () => task({ status: 'running' })),
  };
  return {
    repository,
    handlers: createSessionCompactionHandlers({
      ops: () =>
        ({
          getAgentTurnContext: vi.fn(async () => ({
            appId: 'default',
            agentId: 'agent-1',
            agentSessionId: 'agent-session-1',
            ...input.context,
          })),
        }) as any,
      group: { folder: 'agent-folder' },
      chatJid: 'chat-1',
      threadId: null,
      defaultScope: 'group',
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      getAsyncTaskRepository: () => repository as any,
    }),
  };
}

describe('createSessionCompactionHandlers', () => {
  it('reports completed compaction tasks as ready status', async () => {
    const { handlers: compact } = handlers({ tasks: [task()] });

    await expect(compact.getSessionCompactionStatus()).resolves.toEqual({
      state: 'ready',
    });
  });

  it('reports terminal degraded failed and timeout compaction tasks', async () => {
    for (const [record, state] of [
      [task({ status: 'completed', outputSummary: 'degraded' }), 'degraded'],
      [task({ status: 'failed', errorSummary: 'failed' }), 'failed'],
      [task({ status: 'timed_out', errorSummary: 'timeout' }), 'timeout'],
    ] as const) {
      const { handlers: compact } = handlers({ tasks: [record] });
      await expect(compact.getSessionCompactionStatus()).resolves.toEqual({
        state,
      });
    }
  });

  it('prefers provider session state over terminal task state', async () => {
    const { handlers: compact } = handlers({
      context: { latestProviderSessionReady: true },
      tasks: [task({ outputSummary: 'degraded' })],
    });

    await expect(compact.getSessionCompactionStatus()).resolves.toEqual({
      state: 'ready',
    });
  });

  it('heartbeats a running durable compaction task', async () => {
    const running = task({ status: 'running' });
    const { handlers: compact, repository } = handlers({ tasks: [running] });

    await expect(
      compact.heartbeatSessionCompactionTask(running),
    ).resolves.toMatchObject({ status: 'running' });
    expect(repository.transitionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: running.id,
        leaseToken: running.leaseToken,
        fencingVersion: running.fencingVersion,
        status: 'running',
        heartbeatAt: expect.any(String),
      }),
    );
  });
});
