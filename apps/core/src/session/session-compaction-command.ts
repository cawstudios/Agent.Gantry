import { logger } from '../infrastructure/logging/logger.js';
import type { SessionCommandDeps } from './session-commands.js';

type CompactionProviderSession = {
  providerSessionId: string;
  externalSessionId: string;
};

export const COMPACTION_QUEUED_MESSAGE =
  "Compaction queued. You can keep messaging me; I'll use the compacted context when it's ready.";
export const COMPACTION_ALREADY_RUNNING_MESSAGE =
  'Compaction is already running or queued. You can keep messaging me.';

const COMPACTION_READY_MESSAGE =
  "Compaction ready. I'll use the compacted context and updated memory on your next message.";
const COMPACTION_DEGRADED_MESSAGE =
  "Compaction ready, but memory extraction did not finish. I'll use compacted context and existing memory.";
const COMPACTION_FAILED_MESSAGE =
  "Compaction did not finish. I'll keep using current continuity and memory.";
const COMPACTION_TASK_HEARTBEAT_MS = 60_000;

const queuedCompactions = new Set<string>();

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function hasQueuedSessionCompaction(scopeKey: string): boolean {
  return queuedCompactions.has(scopeKey);
}

export async function queueSessionCompaction(
  groupName: string,
  deps: SessionCommandDeps,
  baseCursor?: string,
): Promise<'queued' | 'already_running'> {
  const dedupeKey = deps.compactionScopeKey?.trim() || groupName;
  const admittedTask = await deps.admitSessionCompactionTask?.();
  if (admittedTask && !admittedTask.admitted) return 'already_running';
  if (!admittedTask && queuedCompactions.has(dedupeKey)) {
    return 'already_running';
  }
  queuedCompactions.add(dedupeKey);
  let locked: CompactionProviderSession | undefined;
  let task = admittedTask?.task;
  if (!admittedTask && deps.beginSessionCompaction) {
    locked = await deps.beginSessionCompaction({ baseCursor });
    if (!locked) {
      queuedCompactions.delete(dedupeKey);
      return 'already_running';
    }
  }
  void (async () => {
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (admittedTask) {
      locked = await deps.beginSessionCompaction?.({ baseCursor });
      if (!locked) {
        await deps.finishSessionCompactionTask?.(task, 'failed');
        await deps.sendMessage(COMPACTION_FAILED_MESSAGE);
        return;
      }
      task =
        (await deps.markSessionCompactionTaskRunning?.(
          admittedTask.task,
          locked,
        )) ?? admittedTask.task;
      if (deps.heartbeatSessionCompactionTask) {
        heartbeatTimer = setInterval(() => {
          void deps
            .heartbeatSessionCompactionTask?.(task)
            .then((next) => {
              if (next) task = next;
            })
            .catch(() => undefined);
        }, COMPACTION_TASK_HEARTBEAT_MS);
        heartbeatTimer.unref?.();
      }
    }
    try {
      let compactError: string | undefined;
      if (!locked) {
        await deps.finishSessionCompactionTask?.(task, 'failed');
        await deps.sendMessage(COMPACTION_FAILED_MESSAGE);
        return;
      }
      const compactResult = await deps.runSessionCompaction(
        async (result) => {
          if (result.status !== 'error') return;
          compactError = resultToText(result.result) || 'Compact failed.';
        },
        { maintenanceProviderSession: locked },
      );

      if (compactResult !== 'success' || compactError) {
        await deps.finishSessionCompactionTask?.(task, 'failed');
        await deps.finishSessionCompaction?.(locked, 'active');
        await deps.sendMessage(COMPACTION_FAILED_MESSAGE);
        return;
      }

      const archiveOutcome = await deps.archiveCurrentSession('manual-compact');
      await deps.onSessionArchived?.('manual-compact');
      await deps.finishSessionCompaction?.(locked, 'ready');
      await deps.finishSessionCompactionTask?.(
        task,
        archiveOutcome && archiveOutcome.memory === 'degraded'
          ? 'degraded'
          : 'ready',
      );
      await deps.sendMessage(
        archiveOutcome && archiveOutcome.memory === 'degraded'
          ? COMPACTION_DEGRADED_MESSAGE
          : COMPACTION_READY_MESSAGE,
      );
    } catch {
      await deps.finishSessionCompactionTask?.(task, 'failed');
      await deps.finishSessionCompaction?.(locked, 'active');
      await deps.sendMessage(COMPACTION_FAILED_MESSAGE);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  })()
    .catch((err) => {
      logger.error({ group: groupName, err }, 'Background compaction crashed');
      void Promise.all([
        deps.finishSessionCompactionTask?.(task, 'failed'),
        deps.finishSessionCompaction?.(locked, 'active'),
        deps.sendMessage(COMPACTION_FAILED_MESSAGE),
      ]).catch(() => undefined);
    })
    .finally(() => {
      queuedCompactions.delete(dedupeKey);
    });
  return 'queued';
}
