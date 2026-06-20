import { describe, expect, it } from 'vitest';

import {
  AsyncCommandTaskService,
  type AsyncCommandRunner,
} from '@core/jobs/async-command-task-service.js';
import type {
  AsyncTaskCreateInput,
  AsyncTaskListFilter,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskTransitionInput,
} from '@core/domain/ports/async-tasks.js';
import { isAsyncTaskTerminal } from '@core/domain/ports/async-tasks.js';

class MemoryAsyncTaskRepository implements AsyncTaskRepository {
  readonly tasks = new Map<string, AsyncTaskRecord>();

  async createTask(input: AsyncTaskCreateInput): Promise<AsyncTaskRecord> {
    const task: AsyncTaskRecord = {
      id: input.id,
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId ?? null,
      threadId: input.threadId ?? null,
      parentRunId: input.parentRunId ?? null,
      parentJobId: input.parentJobId ?? null,
      parentJobRunId: input.parentJobRunId ?? null,
      kind: input.kind,
      status: input.status,
      admissionClass: input.admissionClass,
      authoritySnapshotJson: input.authoritySnapshotJson,
      privateCorrelationJson: input.privateCorrelationJson ?? {},
      leaseToken: input.leaseToken,
      fencingVersion: input.fencingVersion,
      createdAt: input.now,
      updatedAt: input.now,
      summary: input.summary ?? null,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async getTask(taskId: string): Promise<AsyncTaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async listTasks(filter: AsyncTaskListFilter): Promise<AsyncTaskRecord[]> {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.appId === filter.appId &&
          (!filter.agentId || task.agentId === filter.agentId) &&
          (!filter.statuses || filter.statuses.includes(task.status)),
      )
      .slice(0, filter.limit ?? 50);
  }

  async transitionTask(
    input: AsyncTaskTransitionInput,
  ): Promise<AsyncTaskRecord | null> {
    const current = this.tasks.get(input.taskId);
    if (
      !current ||
      current.leaseToken !== input.leaseToken ||
      current.fencingVersion !== input.fencingVersion ||
      isAsyncTaskTerminal(current.status)
    ) {
      return null;
    }
    const next: AsyncTaskRecord = {
      ...current,
      status: input.status,
      updatedAt: input.now,
      heartbeatAt: input.heartbeatAt ?? current.heartbeatAt,
      startedAt: input.startedAt ?? current.startedAt,
      terminalAt: input.terminalAt ?? current.terminalAt,
      privateCorrelationJson:
        input.privateCorrelationJson ?? current.privateCorrelationJson,
      outputSummary: input.outputSummary ?? current.outputSummary,
      errorSummary: input.errorSummary ?? current.errorSummary,
      receiptJson: input.receiptJson ?? current.receiptJson,
    };
    this.tasks.set(next.id, next);
    return next;
  }
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'app-1',
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    command: 'npm test',
    allowedToolRules: ['RunCommand(npm test)'],
    ...overrides,
  };
}

describe('AsyncCommandTaskService', () => {
  it('denies unapproved commands before creating a task or calling the runner', async () => {
    const repository = new MemoryAsyncTaskRepository();
    let calls = 0;
    const runner: AsyncCommandRunner = {
      run: async () => {
        calls += 1;
        return {};
      },
    };
    const service = new AsyncCommandTaskService(repository, runner);

    const result = await service.start(
      baseInput({ allowedToolRules: ['RunCommand(git status)'] }),
    );

    expect(result).toEqual({
      ok: false,
      message:
        'This command is not approved for this agent. Request access or choose an approved capability.',
    });
    expect(calls).toBe(0);
    expect(repository.tasks.size).toBe(0);
  });

  it('redacts command text before persisting durable task metadata', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const runner: AsyncCommandRunner = {
      run: async () => ({ outputSummary: 'done' }),
    };
    const service = new AsyncCommandTaskService(repository, runner);
    const secret = 'bearer abcdefghijklmnopqrstuvwxyz123456';

    const result = await service.start(
      baseInput({
        command: `curl -H "Authorization: ${secret}" https://example.com`,
        allowedToolRules: ['RunCommand(curl *)'],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = repository.tasks.get(result.task.id);
    const persisted = JSON.stringify(task);
    expect(task?.summary).toContain('bearer [REDACTED_SECRET]');
    expect(persisted).not.toContain(secret);
  });

  it('creates a durable row before running and keeps cancellation terminal', async () => {
    const repository = new MemoryAsyncTaskRepository();
    let releaseRunner!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const runner: AsyncCommandRunner = {
      run: async ({ signal, onProcessStarted }) => {
        onProcessStarted?.({
          pid: 12345,
          processGroupId: 12345,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: new Date().toISOString(),
        });
        await runnerStarted;
        if (signal.aborted) throw new Error('aborted');
        return { outputSummary: 'done' };
      },
    };
    const service = new AsyncCommandTaskService(repository, runner);

    const started = await service.start(baseInput());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(repository.tasks.has(started.task.id)).toBe(true);

    await waitForStatus(repository, started.task.id, 'running');
    await expect(service.cancel(started.task.id)).resolves.toEqual({
      ok: true,
      message: 'Task was cancelled. Nothing else changed.',
    });
    releaseRunner();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = repository.tasks.get(started.task.id);
    expect(task?.status).toBe('cancelled');
    expect(task?.privateCorrelationJson).toMatchObject({
      cwd: null,
      process: {
        pid: 12345,
        processGroupId: 12345,
        detached: true,
        platform: process.platform,
        ownerPid: process.pid,
      },
    });
    expect(JSON.stringify(task?.privateCorrelationJson)).not.toContain(
      'npm test',
    );
    expect(task?.receiptJson).toEqual({
      completed: 'cancelled',
      used: 'RunCommand',
      changed: 'none',
      delegated: 'no',
      needsAttention: 'none',
    });
    const dto = await service.get(started.task.id);
    expect(dto).toMatchObject({
      id: started.task.id,
      status: 'cancelled',
      allowedActions: ['get', 'list'],
      receiptLines: [
        'Completed: cancelled',
        'Used: RunCommand',
        'Changed: none',
        'Delegated: no',
        'Needs attention: none',
      ],
    });
    expect(JSON.stringify(dto)).not.toContain('leaseToken');
    expect(JSON.stringify(dto)).not.toContain('privateCorrelationJson');
    expect(JSON.stringify(dto)).not.toContain('fencingVersion');
  });

  it('denies new launches when the agent async command budget is full', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const runner: AsyncCommandRunner = {
      run: async () => new Promise(() => undefined),
    };
    const service = new AsyncCommandTaskService(repository, runner);

    await expect(service.start(baseInput())).resolves.toMatchObject({
      ok: true,
    });
    await expect(service.start(baseInput())).resolves.toMatchObject({
      ok: true,
    });
    await expect(service.start(baseInput())).resolves.toEqual({
      ok: false,
      message:
        'Async command capacity is full for this agent. Wait for an existing task to finish or cancel one.',
    });
  });

  it('does not claim cancellation when this process has no active handle', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-detached',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'lease-1',
      fencingVersion: 1,
      now,
    });
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(service.cancel('task-detached')).resolves.toEqual({
      ok: false,
      message:
        'Task has no recoverable process handle. Wait for stale-task recovery before starting or cancelling it again.',
    });
    expect(repository.tasks.get('task-detached')?.status).toBe('running');
  });

  it('cancels a detached task with its persisted process handle after restart', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-detached',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        process: {
          pid: 45678,
          processGroupId: 45678,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: now,
        },
      },
      leaseToken: 'lease-1',
      fencingVersion: 1,
      now,
    });
    const killed: number[] = [];
    const service = new AsyncCommandTaskService(
      repository,
      {
        run: async () => ({}),
      },
      {
        terminateProcess: (handle) => {
          killed.push(handle.processGroupId ?? handle.pid);
          return true;
        },
      },
    );

    await expect(service.cancel('task-detached')).resolves.toEqual({
      ok: true,
      message: 'Task was cancelled. Nothing else changed.',
    });
    expect(killed).toEqual([45678]);
    expect(repository.tasks.get('task-detached')?.status).toBe('cancelled');
  });

  it('terminates tracked stale task processes during recovery', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const stale = new Date(Date.now() - 120_000).toISOString();
    await repository.createTask({
      id: 'task-stale',
      appId: 'app-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {
        process: {
          pid: 56789,
          processGroupId: 56789,
          detached: true,
          platform: process.platform,
          ownerPid: process.pid,
          startedAt: stale,
        },
      },
      leaseToken: 'lease-1',
      fencingVersion: 1,
      now: stale,
    });
    const killed: number[] = [];
    const service = new AsyncCommandTaskService(
      repository,
      {
        run: async () => ({}),
      },
      {
        terminateProcess: (handle) => {
          killed.push(handle.processGroupId ?? handle.pid);
          return true;
        },
      },
    );

    await expect(
      service.recoverStaleTasks({ appId: 'app-1', staleAfterMs: 1 }),
    ).resolves.toBe(1);
    expect(killed).toEqual([56789]);
    expect(repository.tasks.get('task-stale')?.status).toBe('failed');
  });
});

async function waitForStatus(
  repository: MemoryAsyncTaskRepository,
  taskId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (repository.tasks.get(taskId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Task did not reach ${status}.`);
}
