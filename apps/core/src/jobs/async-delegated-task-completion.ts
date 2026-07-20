import {
  type AgentFailureMetadata,
  type AsyncTaskRecord,
  type AsyncTaskRepository,
  toPublicAsyncTaskDto,
} from '../domain/ports/async-tasks.js';
import { nowIso } from '../shared/time/datetime.js';
import { truncate } from './async-command-task-helpers.js';
import { notifyAsyncTaskChange } from './async-task-change-waiter.js';

export async function finishDelegatedAgentTask(
  repository: AsyncTaskRepository,
  task: AsyncTaskRecord,
  input: {
    status: 'completed' | 'cancelled' | 'timed_out' | 'failed';
    output: string;
    error: string;
    subtasks: string;
    needsAttention: string;
    failure?: AgentFailureMetadata;
    terminalChildren?: ReturnType<typeof toPublicAsyncTaskDto>[];
    onTerminal?: (task: AsyncTaskRecord) => Promise<void> | void;
  },
): Promise<void> {
  const now = nowIso();
  const latest = await repository.getTask(task.id);
  const updated = await repository.transitionTask({
    taskId: task.id,
    leaseToken: task.leaseToken,
    fencingVersion: task.fencingVersion,
    status: input.status,
    now,
    terminalAt: now,
    privateCorrelationJson: {
      ...(latest?.privateCorrelationJson ?? task.privateCorrelationJson),
      ...(input.failure ? { failure: input.failure } : {}),
      ...(input.terminalChildren
        ? { terminalChildren: input.terminalChildren }
        : {}),
    },
    // outputSummary is the durable machine result consumed by task_wait and
    // parent agents. Keep it complete; only observational receipt/progress
    // text is compacted below.
    outputSummary: input.output,
    errorSummary: truncate(input.error),
    receiptJson: {
      completed: truncate(input.output),
      used: 'Gantry agent run',
      changed: 'none',
      delegated: 'yes',
      subtasks: input.subtasks,
      needsAttention: input.needsAttention,
    },
  });
  if (!updated) return;
  notifyAsyncTaskChange(repository);
  try {
    await input.onTerminal?.(updated);
  } catch {
    // The durable task state is authoritative; event consumers fail closed
    // if an optional terminal receipt cannot be published.
  }
}
