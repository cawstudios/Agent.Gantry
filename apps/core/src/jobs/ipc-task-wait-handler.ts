import type {
  CoreTaskLifecycleBackend,
  CoreTaskOwner,
} from '../application/core-tools/task-lifecycle.js';
import type { AsyncCommandTaskService } from './async-command-task-service.js';
import {
  createTaskResponder,
  respondTaskLifecycleResult,
  toTrimmedString,
} from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';

type TaskWaitScope = CoreTaskOwner & { sandboxPolicy: unknown };
type ParentTaskScopeResult =
  | { ok: true; parentTaskId: string | null }
  | { ok: false; message: string };

export function createTaskWaitHandler(input: {
  responder: (context: TaskContext) => ReturnType<typeof createTaskResponder>;
  taskScope: (context: TaskContext) => TaskWaitScope | null;
  taskService: (context: TaskContext) => AsyncCommandTaskService | null;
  validateParentTaskScope: (
    context: TaskContext,
    scope: CoreTaskOwner,
  ) => Promise<ParentTaskScopeResult>;
  taskBackend: (
    context: TaskContext,
    service: AsyncCommandTaskService,
    owner: CoreTaskOwner,
    parent: { parentTaskId: string | null },
  ) => CoreTaskLifecycleBackend;
}): TaskHandler {
  return async (context) => {
    const { reject } = input.responder(context);
    const scope = input.taskScope(context);
    if (!scope) {
      reject(
        'task_wait must target the originating app, agent, and conversation.',
        'forbidden',
      );
      return;
    }
    const service = input.taskService(context);
    if (!service) {
      reject('Async task runtime is unavailable.', 'unavailable');
      return;
    }
    const payload = context.data.payload ?? {};
    const taskIds = Array.isArray(payload.taskIds)
      ? payload.taskIds
          .map((value) => toTrimmedString(value, { maxLen: 160 }))
          .filter((value): value is string => Boolean(value))
      : [];
    const timeoutMs =
      typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined;
    const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
    const parentTask = await input.validateParentTaskScope(
      context,
      scopedTaskOwner,
    );
    if (!parentTask.ok) {
      reject(parentTask.message, 'forbidden');
      return;
    }
    const tasks = input.taskBackend(
      context,
      service,
      scopedTaskOwner,
      parentTask,
    );
    respondTaskLifecycleResult(
      context,
      await tasks.task_wait({ taskIds, timeoutMs }),
    );
  };
}
