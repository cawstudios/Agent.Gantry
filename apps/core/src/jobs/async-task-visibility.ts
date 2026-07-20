import {
  type AsyncTaskRecord,
  type AsyncTaskRepository,
  type PublicAsyncTaskDto,
  isAsyncTaskTerminal,
  toPublicAsyncTaskDto,
} from '../domain/ports/async-tasks.js';
import { taskInScope } from './async-command-task-helpers.js';
import type { AsyncTaskChangeWaiter } from './async-task-change-waiter.js';

export interface ScopedAsyncTaskInput {
  taskId: string;
  appId: string;
  agentId: string;
  conversationId?: string | null;
  providerAccountId?: string | null;
  threadId?: string | null;
  parentTaskId?: string | null;
}

export interface AsyncTaskListInput {
  appId: string;
  agentId?: string;
  conversationId?: string | null;
  providerAccountId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  parentTaskId?: string | null;
  limit?: number;
}

export interface AsyncTaskWaitInput {
  taskIds: string[];
  appId: string;
  agentId: string;
  conversationId?: string | null;
  providerAccountId?: string | null;
  threadId?: string | null;
  parentTaskId?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function isAgentFacingTask(task: AsyncTaskRecord): boolean {
  return task.kind !== 'session_compaction';
}

export async function getScopedAsyncTask(
  repository: AsyncTaskRepository,
  input: ScopedAsyncTaskInput,
): Promise<PublicAsyncTaskDto | null> {
  const task = await repository.getTask(input.taskId);
  return task && isAgentFacingTask(task) && taskInScope(task, input)
    ? toPublicAsyncTaskDto(task)
    : null;
}

export async function listVisibleAsyncTasks(
  repository: AsyncTaskRepository,
  input: AsyncTaskListInput,
): Promise<PublicAsyncTaskDto[]> {
  const tasks = await repository.listTasks(input);
  return tasks
    .filter((task) => isAgentFacingTask(task) && taskInScope(task, input))
    .map(toPublicAsyncTaskDto);
}

export async function waitForAsyncTasks(input: {
  request: AsyncTaskWaitInput;
  repository: AsyncTaskRepository;
  changes: AsyncTaskChangeWaiter;
}): Promise<{
  ok: boolean;
  message: string;
  tasks?: PublicAsyncTaskDto[];
  timedOut?: boolean;
}> {
  const { request } = input;
  const deadline = Date.now() + request.timeoutMs;
  const signal = request.signal ?? new AbortController().signal;
  for (;;) {
    const records = await Promise.all(
      request.taskIds.map((taskId) => input.repository.getTask(taskId)),
    );
    if (
      records.some(
        (task) =>
          !task || !isAgentFacingTask(task) || !taskInScope(task, request),
      )
    ) {
      return { ok: false, message: 'One or more tasks were not found.' };
    }
    const tasks = records as AsyncTaskRecord[];
    const publicTasks = tasks.map(toPublicAsyncTaskDto);
    if (tasks.every((task) => isAsyncTaskTerminal(task.status))) {
      return {
        ok: true,
        message: 'All selected tasks reached terminal states.',
        tasks: publicTasks,
        timedOut: false,
      };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || signal.aborted) {
      return {
        ok: true,
        message: signal.aborted
          ? 'Task wait was cancelled.'
          : 'Task wait timeout expired.',
        tasks: publicTasks,
        timedOut: true,
      };
    }
    await input.changes.wait({ signal, timeoutMs: remainingMs });
  }
}
