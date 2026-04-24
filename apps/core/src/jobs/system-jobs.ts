import {
  MEMORY_DREAMING_CRON,
  RUNTIME_MEMORY_DREAMING_ENABLED,
} from '../config/index.js';
import type { Job } from '../domain/types.js';
import { runMemoryCleanupInSubprocess } from '../memory/cleanup-job.js';
import {
  getMemoryMaintenanceQueue,
  type MemoryMaintenanceQueueEnqueueResult,
} from '../memory/maintenance-queue.js';
import { MemoryService } from '../memory/memory-service.js';
import { nowIso as currentIso } from '../infrastructure/time/datetime.js';
import {
  getSystemJobRegistrationSignature,
  setSystemJobRegistrationSignature,
} from './system-registration-cache.js';
import { computeNextJobRun } from './schedule-math.js';
import type { SchedulerDependencies } from './types.js';

export const MEMORY_DREAM_SYSTEM_PROMPT = '__system:memory_dream';
export const MEMORY_CLEANUP_SYSTEM_PROMPT = '__system:memory_cleanup';

type MemoryMaintenanceQueueLike = {
  enqueueAndWait: (
    groupFolder: string,
    task: () => Promise<void>,
    dedupeKey?: string,
  ) => Promise<MemoryMaintenanceQueueEnqueueResult>;
  getPendingCount: () => number;
};

let memoryMaintenanceQueue: MemoryMaintenanceQueueLike =
  getMemoryMaintenanceQueue();

export async function registerSystemJobs(
  deps: SchedulerDependencies,
): Promise<void> {
  const groups = deps.registeredGroups();
  const byFolder = new Map<string, string[]>();
  const mainFolders = new Set<string>();

  for (const [jid, group] of Object.entries(groups)) {
    const linked = byFolder.get(group.folder) || [];
    linked.push(jid);
    byFolder.set(group.folder, linked);
    if (group.isMain) {
      mainFolders.add(group.folder);
    }
  }

  const cleanupOwnerEntry =
    [...byFolder.entries()].find(([folder]) => mainFolders.has(folder)) ||
    [...byFolder.entries()][0];
  const registrationSignature = JSON.stringify({
    dreamingEnabled: RUNTIME_MEMORY_DREAMING_ENABLED,
    dreamingCron: MEMORY_DREAMING_CRON,
    folders: [...byFolder.entries()]
      .map(([folder, linkedSessions]) => [folder, [...linkedSessions].sort()])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    cleanupOwnerFolder: cleanupOwnerEntry?.[0] ?? null,
  });
  if (
    getSystemJobRegistrationSignature(deps.opsRepository) ===
    registrationSignature
  ) {
    return;
  }

  if (!cleanupOwnerEntry) return;
  const nowIso = currentIso();
  if (RUNTIME_MEMORY_DREAMING_ENABLED) {
    for (const [groupFolder, linkedSessions] of byFolder.entries()) {
      const jobId = `system:dreaming:${groupFolder}`;
      const existing = await deps.opsRepository.getJobById(jobId);
      if (existing?.status === 'dead_lettered') {
        continue;
      }
      const computedNextRun = computeNextJobRun(
        {
          schedule_type: 'cron',
          schedule_value: MEMORY_DREAMING_CRON,
        },
        nowIso,
      );
      const nextRun = existing?.next_run || computedNextRun;
      const desiredStatus = existing?.status === 'paused' ? 'paused' : 'active';

      await deps.opsRepository.upsertJob({
        id: jobId,
        name: `Memory Dreaming (${groupFolder})`,
        prompt: MEMORY_DREAM_SYSTEM_PROMPT,
        schedule_type: 'cron',
        schedule_value: MEMORY_DREAMING_CRON,
        linked_sessions: linkedSessions,
        session_id: existing?.session_id ?? null,
        group_scope: groupFolder,
        created_by: 'agent',
        status: desiredStatus,
        next_run: nextRun,
        silent: false,
        timeout_ms: 300_000,
        max_retries: 1,
        retry_backoff_ms: 30_000,
        max_consecutive_failures: 3,
      });
    }
  }

  const [cleanupGroupFolder, cleanupLinkedSessions] = cleanupOwnerEntry;
  const cleanupJobId = `system:cleanup:${cleanupGroupFolder}`;
  const cleanupExisting = await deps.opsRepository.getJobById(cleanupJobId);
  const cleanupNextRun =
    cleanupExisting?.next_run ||
    computeNextJobRun(
      {
        schedule_type: 'cron',
        schedule_value: '0 4 * * *',
      },
      nowIso,
    );
  await deps.opsRepository.upsertJob({
    id: cleanupJobId,
    name: `Memory Cleanup (${cleanupGroupFolder})`,
    prompt: MEMORY_CLEANUP_SYSTEM_PROMPT,
    schedule_type: 'cron',
    schedule_value: '0 4 * * *',
    linked_sessions: cleanupLinkedSessions,
    session_id: cleanupExisting?.session_id ?? null,
    group_scope: cleanupGroupFolder,
    created_by: 'agent',
    status: cleanupExisting?.status === 'paused' ? 'paused' : 'active',
    next_run: cleanupNextRun,
    silent: true,
    timeout_ms: 120_000,
    max_retries: 1,
    retry_backoff_ms: 15_000,
    max_consecutive_failures: 3,
  });
  for (const groupFolder of byFolder.keys()) {
    if (groupFolder === cleanupGroupFolder) continue;
    await deps.opsRepository.deleteJob(`system:cleanup:${groupFolder}`);
  }
  setSystemJobRegistrationSignature(deps.opsRepository, registrationSignature);
}

export async function handleSystemJob(
  job: Job,
  groupFolder: string,
): Promise<unknown> {
  if (job.prompt === MEMORY_DREAM_SYSTEM_PROMPT) {
    const queueResult = await memoryMaintenanceQueue.enqueueAndWait(
      groupFolder,
      async () => {
        await MemoryService.getInstance().runDreamingSweep(groupFolder);
      },
      `dream:${groupFolder}`,
    );
    if (!queueResult.queued) {
      if (queueResult.reason === 'full') {
        throw new Error('memory maintenance queue full');
      }
      if (queueResult.reason === 'invalid') {
        throw new Error('invalid memory maintenance group');
      }
    }
    return {
      queued: queueResult.queued,
      pending: memoryMaintenanceQueue.getPendingCount(),
      deduped: queueResult.deduped,
    };
  }
  if (job.prompt === MEMORY_CLEANUP_SYSTEM_PROMPT) {
    const queueResult = await memoryMaintenanceQueue.enqueueAndWait(
      groupFolder,
      async () => {
        await runMemoryCleanupInSubprocess();
      },
      `cleanup:${groupFolder}`,
    );
    if (!queueResult.queued) {
      if (queueResult.reason === 'full') {
        throw new Error('memory maintenance queue full');
      }
      if (queueResult.reason === 'invalid') {
        throw new Error('invalid memory maintenance group');
      }
    }
    return {
      queued: queueResult.queued,
      pending: memoryMaintenanceQueue.getPendingCount(),
      deduped: queueResult.deduped,
    };
  }
  throw new Error(`Unknown system job: ${job.prompt}`);
}

export function resetSystemJobStateForTests(): void {
  memoryMaintenanceQueue = getMemoryMaintenanceQueue();
}

export function _setMemoryMaintenanceQueueForTests(queue: unknown): void {
  memoryMaintenanceQueue =
    (queue as MemoryMaintenanceQueueLike | null) ?? getMemoryMaintenanceQueue();
}