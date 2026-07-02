import {
  ASYNC_TASK_STALE_AFTER_MS,
  AsyncCommandTaskService,
} from '../../jobs/async-command-task-service.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { IpcDeps } from '../../runtime/ipc.js';

interface AsyncTaskRecoveryDeps {
  getAsyncTaskRepository?: IpcDeps['getAsyncTaskRepository'];
  logger: Pick<Logger, 'warn'>;
}

export async function recoverStaleAsyncCommandTasks(
  appId: string,
  deps: AsyncTaskRecoveryDeps,
): Promise<void> {
  const repository = deps.getAsyncTaskRepository?.();
  if (!repository) return;
  const service = new AsyncCommandTaskService(repository, {
    run: async () => ({ errorSummary: 'async command runner unavailable' }),
  });
  try {
    const recovered = await service.recoverStaleTasks({
      appId,
      staleAfterMs: ASYNC_TASK_STALE_AFTER_MS,
    });
    if (recovered > 0) {
      deps.logger.warn({ recovered }, 'Recovered stale async command tasks');
    }
  } catch (err) {
    deps.logger.warn({ err }, 'Failed to recover stale async command tasks');
  }
}

const ASYNC_TASK_RECOVERY_INTERVAL_MS = 30_000;
let activeAsyncTaskRecoveryLoop: NodeJS.Timeout | undefined;

export function startAsyncTaskRecoveryLoop(
  appId: string,
  deps: AsyncTaskRecoveryDeps,
): void {
  stopAsyncTaskRecoveryLoop();
  activeAsyncTaskRecoveryLoop = setInterval(() => {
    void recoverStaleAsyncCommandTasks(appId, deps);
  }, ASYNC_TASK_RECOVERY_INTERVAL_MS);
  activeAsyncTaskRecoveryLoop.unref?.();
}

export function stopAsyncTaskRecoveryLoop(): void {
  if (!activeAsyncTaskRecoveryLoop) return;
  clearInterval(activeAsyncTaskRecoveryLoop);
  activeAsyncTaskRecoveryLoop = undefined;
}
