import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AsyncTaskCreateInput,
  AsyncTaskListFilter,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskTransitionInput,
} from '@core/domain/ports/async-tasks.js';
import { isAsyncTaskTerminal } from '@core/domain/ports/async-tasks.js';
import type { RunnerSandboxProvider } from '@core/shared/runner-sandbox-provider.js';

const runtimeHomes: string[] = [];

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
          (filter.conversationId === undefined ||
            task.conversationId === filter.conversationId) &&
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

function fakeEnforcingSandboxProvider(input?: {
  onKill?: () => void;
  onStart?: (options: unknown) => void;
}): RunnerSandboxProvider {
  return {
    id: 'sandbox_runtime',
    enforcing: true,
    start: vi.fn((options) => {
      input?.onStart?.(options);
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => {
        input?.onKill?.();
        setImmediate(() => {
          child.emit('exit', null, 'SIGTERM');
          child.emit('close', null, 'SIGTERM');
        });
        return true;
      });
      return child as never;
    }),
  };
}

async function loadTaskLifecycleHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const asyncPolicy =
    await import('@core/runtime/async-command-sandbox-policy.js');
  const handlers =
    await import('@core/jobs/ipc-agent-task-lifecycle-handlers.js');
  return {
    ...handlers,
    ...asyncPolicy,
    taskData: (
      taskId: string,
      type: string,
      payload: Record<string, unknown> = {},
    ) => {
      const envelope = ipcAuth.createIpcAuthEnvelope('main_agent', 'thread-1');
      return {
        type,
        taskId,
        appId: 'app:test',
        agentId: 'agent:main_agent',
        chatJid: 'sl:C123',
        jid: 'sl:C123',
        authThreadId: 'thread-1',
        responseKeyId: envelope.responseKeyId,
        runHandle: 'run-1',
        runId: 'run-id-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 7,
        payload,
      };
    },
  };
}

function readResponse(runtimeHome: string, taskId: string) {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        runtimeHome,
        'data',
        'ipc',
        'main_agent',
        'task-responses',
        `task-${taskId}.json`,
      ),
      'utf-8',
    ),
  );
}

function contextFor(input: {
  data: Record<string, unknown>;
  renderAgentTodo?: ReturnType<typeof vi.fn>;
  deps?: Record<string, unknown>;
}) {
  return {
    data: input.data,
    sourceAgentFolder: 'main_agent',
    deps: {
      ...(input.renderAgentTodo
        ? { renderAgentTodo: input.renderAgentTodo }
        : {}),
      ...(input.deps ?? {}),
    },
    conversationBindings: {},
    sourceAgentFolderJids: ['sl:C123'],
  } as never;
}

async function waitForStatus(
  repository: MemoryAsyncTaskRepository,
  status: string,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = [...repository.tasks.values()].find(
      (candidate) => candidate.status === status,
    );
    if (task) return task.id;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Task did not reach ${status}.`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('agent task lifecycle IPC handlers', () => {
  it('renders bounded todo state and returns stable user copy', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const renderAgentTodo = vi.fn(async () => undefined);

    await agentTaskLifecycleHandlers.todo_update(
      contextFor({
        data: taskData('todo-ok', 'todo_update', {
          summary: 'Current plan',
          items: [
            {
              id: 'step-1',
              title: 'Validate contract',
              status: 'inProgress',
              note: 'Checking surface',
            },
          ],
        }),
        renderAgentTodo,
      }),
    );

    expect(renderAgentTodo).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        summary: 'Current plan',
        items: [
          {
            id: 'step-1',
            title: 'Validate contract',
            status: 'inProgress',
            note: 'Checking surface',
          },
        ],
        threadId: 'thread-1',
      }),
    );
    expect(readResponse(runtimeHome, 'todo-ok')).toMatchObject({
      ok: true,
      message: 'Plan updated.',
    });
  });

  it('rejects invalid todo_update before channel render', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { agentTaskLifecycleHandlers, taskData } =
      await loadTaskLifecycleHandlers(runtimeHome);
    const renderAgentTodo = vi.fn();

    await agentTaskLifecycleHandlers.todo_update(
      contextFor({
        data: taskData('todo-stale', 'todo_update', {
          items: [{ id: 'step-1', title: 'Validate', status: 'invalid' }],
        }),
        renderAgentTodo,
      }),
    );

    expect(renderAgentTodo).not.toHaveBeenCalled();
    expect(readResponse(runtimeHome, 'todo-stale')).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error:
        'todo_update requires 1-50 unique items with id, title, and status.',
    });
  });

  it('starts, reads, lists, and cancels scoped async command tasks', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    const deps = {
      getAsyncTaskRepository: () => repository,
      getToolRepository: () =>
        ({
          listAgentToolBindings: async () => [
            { status: 'active', toolId: 'tool:permission-rule:test' },
          ],
          getTool: async () => ({
            appId: 'app:test',
            name: 'RunCommand(echo *)',
          }),
        }) as never,
      runnerSandboxProvider: fakeEnforcingSandboxProvider({
        onStart: (options) => {
          expect(options).toMatchObject({
            cwd: path.join(runtimeHome, 'agents', 'main_agent'),
            workspaceRoot: path.join(runtimeHome, 'agents', 'main_agent'),
            protectedReadPaths: ['/protected/read'],
            protectedWritePaths: ['/protected/write'],
            allowedNetworkHosts: ['127.0.0.1:1234'],
            egressProxyUrl: 'http://127.0.0.1:1234',
            resourceLimits: {
              cpuSeconds: 10,
              memoryMb: 128,
              maxProcesses: 8,
            },
            sandboxProfile: {
              network: 'required',
            },
          });
        },
      }),
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        threadId: 'thread-1',
        runId: 'run-id-1',
        protectedReadPaths: ['/protected/read'],
        protectedWritePaths: ['/protected/write'],
        allowedNetworkHosts: ['127.0.0.1:1234'],
        resourceLimits: {
          cpuSeconds: 10,
          memoryMb: 128,
          maxProcesses: 8,
        },
      },
    });

    await agentTaskLifecycleHandlers.async_run_command(
      contextFor({
        data: taskData('async-start', 'async_run_command', {
          command: 'echo ok',
          protectedFilesystemDenyReadPaths: ['/protected/read'],
          protectedFilesystemDenyWritePaths: ['/protected/write'],
          sandboxAllowedNetworkHosts: ['127.0.0.1:1234'],
          egressProxyUrl: 'http://127.0.0.1:1234',
          sandboxResourceLimits: {
            cpuSeconds: 10,
            memoryMb: 128,
            maxProcesses: 8,
          },
        }),
        deps,
      }),
    );

    const taskId = await waitForStatus(repository, 'running');
    expect(readResponse(runtimeHome, 'async-start')).toMatchObject({
      ok: true,
      message: 'Started: echo ok',
      data: { id: taskId, status: 'queued', kind: 'async_command' },
    });

    await agentTaskLifecycleHandlers.task_get(
      contextFor({
        data: {
          ...taskData('async-cross-app-get', 'task_get', { taskId }),
          appId: 'app:other',
        },
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'async-cross-app-get')).toMatchObject({
      ok: false,
      code: 'forbidden',
    });

    await agentTaskLifecycleHandlers.task_get(
      contextFor({
        data: taskData('async-get', 'task_get', { taskId }),
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'async-get')).toMatchObject({
      ok: true,
      data: { id: taskId, status: 'running' },
    });

    await agentTaskLifecycleHandlers.task_list(
      contextFor({
        data: taskData('async-list', 'task_list', {}),
        deps,
      }),
    );
    expect(readResponse(runtimeHome, 'async-list')).toMatchObject({
      ok: true,
      data: { tasks: [expect.objectContaining({ id: taskId })] },
    });

    await agentTaskLifecycleHandlers.task_cancel(
      contextFor({
        data: taskData('async-cancel', 'task_cancel', { taskId }),
        deps,
      }),
    );
    expect(repository.tasks.get(taskId)?.status).toBe('cancelled');
    expect(readResponse(runtimeHome, 'async-cancel')).toMatchObject({
      ok: true,
      message: 'Task was cancelled. Nothing else changed.',
      data: { taskId },
    });
  });

  it('stores scheduled job run ids in the job-run parent column', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-task-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const {
      agentTaskLifecycleHandlers,
      taskData,
      registerAsyncCommandSandboxPolicy,
    } = await loadTaskLifecycleHandlers(runtimeHome);
    const repository = new MemoryAsyncTaskRepository();
    const deps = {
      getAsyncTaskRepository: () => repository,
      getToolRepository: () =>
        ({
          listAgentToolBindings: async () => [
            { status: 'active', toolId: 'tool:permission-rule:test' },
          ],
          getTool: async () => ({
            appId: 'app:test',
            name: 'RunCommand(echo *)',
          }),
        }) as never,
      runnerSandboxProvider: fakeEnforcingSandboxProvider(),
    };
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: 'main_agent',
      runHandle: 'run-1',
      policy: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        conversationId: 'sl:C123',
        threadId: 'thread-1',
        runId: 'job-run-1',
        jobId: 'job-1',
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: {
          cpuSeconds: 300,
          memoryMb: 1024,
          maxProcesses: 64,
        },
      },
    });

    await agentTaskLifecycleHandlers.async_run_command(
      contextFor({
        data: {
          ...taskData('async-job-start', 'async_run_command', {
            command: 'echo ok',
          }),
          jobId: 'job-1',
          runId: 'job-run-1',
        },
        deps,
      }),
    );

    const taskId = await waitForStatus(repository, 'running');
    expect(repository.tasks.get(taskId)).toMatchObject({
      parentRunId: null,
      parentJobId: 'job-1',
      parentJobRunId: 'job-run-1',
    });
    await agentTaskLifecycleHandlers.task_cancel(
      contextFor({
        data: {
          ...taskData('async-job-cancel', 'task_cancel', { taskId }),
          jobId: 'job-1',
          runId: 'job-run-1',
        },
        deps,
      }),
    );
  });
});
