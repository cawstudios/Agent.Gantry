import { randomUUID } from 'crypto';
import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  MEMORY_DREAMING_CRON,
  MEMORY_DREAMING_ENABLED,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from '../core/config.js';
import { Job, RegisteredGroup } from '../core/types.js';
import { logger } from '../core/logger.js';
import { writeMemoryContextSnapshot } from '../memory/memory-ipc.js';
import { MemoryService } from '../memory/memory-service.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { GroupQueue } from './group-queue.js';
import { AgentOutput, spawnAgent } from './agent-spawn.js';
import {
  addJobEvent,
  completeJobRun,
  createJobRun,
  deleteJob,
  getAllJobs,
  getJobById,
  listDueJobs,
  markJobRunNotified,
  markJobRunning,
  releaseStaleJobLeases,
  upsertJob,
  updateJob,
} from '../storage/db.js';
import { StreamingChunkOptions } from '../core/types.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendStreamingChunk?: (
    jid: string,
    text: string,
    options?: StreamingChunkOptions,
  ) => Promise<void>;
  resetStreaming?: (jid: string) => void;
  onSchedulerChanged?: () => void;
}

const DEFAULT_JOB_CLEANUP_AFTER_MS = 86_400_000;
let schedulerStreamingGenerationCounter = 0;

function nextSchedulerStreamingGeneration(): number {
  schedulerStreamingGenerationCounter += 1;
  return schedulerStreamingGenerationCounter;
}

function normalizeCleanupAfterMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_JOB_CLEANUP_AFTER_MS;
  }
  return Math.max(0, Math.round(value));
}

function shouldDeleteCompletedOneTimeJob(job: Job, nowMs: number): boolean {
  if (job.schedule_type !== 'once') return false;
  if (job.status !== 'completed' && job.status !== 'dead_lettered') {
    return false;
  }
  const cleanupAfterMs = normalizeCleanupAfterMs(job.cleanup_after_ms);
  if (cleanupAfterMs === 0) return true;
  const anchorIso = job.last_run || job.updated_at || job.created_at;
  const anchor = Date.parse(anchorIso);
  const anchorMs = Number.isFinite(anchor) ? anchor : nowMs;
  return nowMs - anchorMs >= cleanupAfterMs;
}

function sweepCompletedOneTimeJobs(): boolean {
  const jobs = getAllJobs();
  const nowMs = Date.now();
  let deleted = false;
  for (const job of jobs) {
    if (!shouldDeleteCompletedOneTimeJob(job, nowMs)) continue;
    deleteJob(job.id);
    deleted = true;
  }
  return deleted;
}

const MEMORY_DREAM_SYSTEM_PROMPT = '__system:memory_dream';

export function computeNextJobRun(
  job: Pick<Job, 'schedule_type' | 'schedule_value'>,
  scheduledFor: string | null,
): string | null {
  if (job.schedule_type === 'once' || job.schedule_type === 'manual') {
    return null;
  }

  if (job.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(job.schedule_value, {
      tz: TIMEZONE,
      currentDate: scheduledFor || new Date().toISOString(),
    });
    return interval.next().toISOString();
  }

  const ms = parseInt(job.schedule_value, 10);
  if (!ms || ms <= 0) {
    return new Date(Date.now() + 60_000).toISOString();
  }

  const parsedAnchor = scheduledFor ? Date.parse(scheduledFor) : Date.now();
  const anchor = Number.isFinite(parsedAnchor) ? parsedAnchor : Date.now();
  const now = Date.now();
  const steps = anchor >= now ? 1 : Math.floor((now - anchor) / ms) + 1;
  const next = anchor + steps * ms;

  if (!Number.isFinite(next) || Math.abs(next) > 8.64e15) {
    return new Date(now + 60_000).toISOString();
  }
  return new Date(next).toISOString();
}

function formatRunStatusMessage(args: {
  job: Job;
  runId: string;
  runStatus: 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  summary: string;
  nextRun: string | null;
  retryCount: number;
  pauseReason?: string | null;
}): string {
  const base = [
    `Scheduler Update`,
    `job_id: ${args.job.id}`,
    `run_id: ${args.runId}`,
    `status: ${args.runStatus}`,
    `summary: ${args.summary}`,
  ];
  if (args.runStatus === 'completed') {
    base.push(`next_run: ${args.nextRun || 'none'}`);
  } else {
    base.push(`retry_count: ${args.retryCount}`);
    base.push(`retry_state: ${args.nextRun ? 'scheduled' : 'stopped'}`);
    base.push(
      `pause_state: ${args.runStatus === 'dead_lettered' ? 'paused' : 'active'}`,
    );
    if (args.pauseReason) {
      base.push(`pause_reason: ${args.pauseReason}`);
    }
  }
  return base.join('\n');
}

function resolveExecutionContext(
  job: Job,
  groups: Record<string, RegisteredGroup>,
): { group: RegisteredGroup; executionJid: string } | null {
  const byFolder = Object.entries(groups).find(
    ([, group]) => group.folder === job.group_scope,
  );
  if (byFolder) {
    return {
      group: byFolder[1],
      executionJid: job.linked_sessions[0] || byFolder[0],
    };
  }

  for (const linked of job.linked_sessions) {
    const group = groups[linked];
    if (group) {
      return { group, executionJid: linked };
    }
  }
  return null;
}

async function notifyLinkedSessions(
  job: Job,
  text: string,
  sendMessage: SchedulerDependencies['sendMessage'],
): Promise<boolean> {
  const unique = Array.from(new Set(job.linked_sessions));
  let delivered = false;
  for (const jid of unique) {
    try {
      await sendMessage(jid, text);
      delivered = true;
    } catch (err) {
      logger.warn(
        { jobId: job.id, jid, err },
        'Failed to send scheduler status message',
      );
    }
  }
  return delivered;
}

function registerSystemJobs(deps: SchedulerDependencies): void {
  if (!MEMORY_DREAMING_ENABLED) return;
  const groups = deps.registeredGroups();
  const byFolder = new Map<string, string[]>();

  for (const [jid, group] of Object.entries(groups)) {
    const linked = byFolder.get(group.folder) || [];
    linked.push(jid);
    byFolder.set(group.folder, linked);
  }

  const nowIso = new Date().toISOString();
  for (const [groupFolder, linkedSessions] of byFolder.entries()) {
    const jobId = `system:dreaming:${groupFolder}`;
    const existing = getJobById(jobId);
    const nextRun =
      existing?.next_run ||
      computeNextJobRun(
        {
          schedule_type: 'cron',
          schedule_value: MEMORY_DREAMING_CRON,
        },
        nowIso,
      );

    upsertJob({
      id: jobId,
      name: `Memory Dreaming (${groupFolder})`,
      prompt: MEMORY_DREAM_SYSTEM_PROMPT,
      schedule_type: 'cron',
      schedule_value: MEMORY_DREAMING_CRON,
      linked_sessions: linkedSessions,
      group_scope: groupFolder,
      created_by: 'agent',
      status: existing?.status || 'active',
      next_run: nextRun,
      timeout_ms: 300_000,
      max_retries: 1,
      retry_backoff_ms: 30_000,
      max_consecutive_failures: 3,
    });
  }
}

async function handleSystemJob(
  job: Job,
  groupFolder: string,
): Promise<unknown> {
  if (job.prompt === MEMORY_DREAM_SYSTEM_PROMPT) {
    return MemoryService.getInstance().runDreamingSweep(groupFolder);
  }
  throw new Error(`Unknown system job: ${job.prompt}`);
}

async function runJob(job: Job, deps: SchedulerDependencies): Promise<void> {
  const currentJob = getJobById(job.id);
  if (!currentJob || currentJob.status !== 'active') {
    return;
  }

  const groups = deps.registeredGroups();
  const execution = resolveExecutionContext(currentJob, groups);
  if (!execution) {
    updateJob(currentJob.id, {
      status: 'dead_lettered',
      pause_reason: `Group scope not found: ${currentJob.group_scope}`,
      next_run: null,
    });
    deps.onSchedulerChanged?.();
    return;
  }

  const scheduledFor = currentJob.next_run || new Date().toISOString();
  const runId = randomUUID();
  const timeoutMs = Math.max(30_000, currentJob.timeout_ms || 300_000);
  const leaseExpiresAt = new Date(
    Date.now() + timeoutMs + 30_000,
  ).toISOString();

  if (!markJobRunning(currentJob.id, runId, leaseExpiresAt)) {
    return;
  }

  const runCreated = createJobRun({
    run_id: runId,
    job_id: currentJob.id,
    scheduled_for: scheduledFor,
    started_at: new Date().toISOString(),
    ended_at: null,
    status: 'running',
    result_summary: null,
    error_summary: null,
    retry_count: currentJob.consecutive_failures,
    notified_at: null,
  });
  if (!runCreated) {
    updateJob(currentJob.id, {
      status: 'active',
      lease_run_id: null,
      lease_expires_at: null,
    });
    deps.onSchedulerChanged?.();
    return;
  }

  let result: string | null = null;
  let error: string | null = null;
  let collectedResult = '';

  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(execution.group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const sessions = deps.getSessions();
  const sessionId = sessions[execution.group.folder];
  const isMain = execution.group.isMain === true;
  let retrievedItemIds: string[] = [];
  let ranSystemJob = false;
  const linkedSessions = Array.from(new Set(currentJob.linked_sessions));
  const shouldDeliverToChat = !currentJob.silent && linkedSessions.length > 0;
  const streamGeneration = nextSchedulerStreamingGeneration();

  const buildStreamingOptions = (args: {
    done?: boolean;
  }): StreamingChunkOptions => {
    const options: StreamingChunkOptions = {
      generation: streamGeneration,
    };
    if (currentJob.thread_id) options.threadId = currentJob.thread_id;
    if (args.done !== undefined) options.done = args.done;
    return options;
  };

  const resetDeliveryStreams = () => {
    if (!deps.resetStreaming || !shouldDeliverToChat) return;
    for (const jid of linkedSessions) {
      try {
        deps.resetStreaming(jid);
      } catch (err) {
        logger.debug(
          { err, jid, jobId: currentJob.id },
          'Failed to reset scheduler stream state',
        );
      }
    }
  };

  const deliverMessage = async (text: string): Promise<boolean> => {
    if (!shouldDeliverToChat || !text) return false;
    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        await deps.sendMessage(jid, text);
        delivered = true;
      } catch (err) {
        logger.warn(
          { jobId: currentJob.id, jid, err },
          'Failed to deliver scheduler message',
        );
      }
    }
    return delivered;
  };

  const deliverStreamingChunk = async (text: string): Promise<boolean> => {
    if (!shouldDeliverToChat || !text) return false;
    if (!deps.sendStreamingChunk) {
      return deliverMessage(text);
    }

    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        await deps.sendStreamingChunk(jid, text, buildStreamingOptions({}));
        delivered = true;
      } catch (err) {
        logger.warn(
          { jobId: currentJob.id, jid, err },
          'Failed to deliver scheduler stream chunk',
        );
      }
    }
    return delivered;
  };

  let streamFinalized = false;
  const finalizeStreaming = async (): Promise<boolean> => {
    if (!shouldDeliverToChat || !deps.sendStreamingChunk || streamFinalized) {
      return false;
    }
    streamFinalized = true;
    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        await deps.sendStreamingChunk(
          jid,
          '',
          buildStreamingOptions({ done: true }),
        );
        delivered = true;
      } catch (err) {
        logger.warn(
          { jobId: currentJob.id, jid, err },
          'Failed to finalize scheduler stream',
        );
      }
    }
    return delivered;
  };

  if (shouldDeliverToChat) {
    resetDeliveryStreams();
    await deliverMessage(`🔔 Scheduled task: ${currentJob.name}`);
  }

  if (!error && currentJob.prompt.startsWith('__system:')) {
    try {
      const systemResult = await handleSystemJob(
        currentJob,
        execution.group.folder,
      );
      result = JSON.stringify(systemResult);
      collectedResult = result;
      ranSystemJob = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } else {
    if (!error) {
      try {
        const contextSnapshot = await writeMemoryContextSnapshot(
          execution.group.folder,
          isMain,
          currentJob.prompt,
          undefined,
        );
        retrievedItemIds = contextSnapshot.retrievedItemIds;
      } catch (err) {
        logger.warn(
          { err, jobId: currentJob.id },
          'Memory context snapshot failed for job',
        );
      }
    }

    const JOB_CLOSE_DELAY_MS = 10_000;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleClose = () => {
      if (closeTimer) return;
      closeTimer = setTimeout(() => {
        deps.queue.closeStdin(execution.executionJid);
      }, JOB_CLOSE_DELAY_MS);
    };

    if (!error) {
      let deliveredAnyOutput = false;
      try {
        const output = await spawnAgent(
          execution.group,
          {
            prompt: currentJob.prompt,
            model: currentJob.model || undefined,
            sessionId,
            groupFolder: execution.group.folder,
            chatJid: execution.executionJid,
            isMain,
            isScheduledJob: true,
            assistantName: ASSISTANT_NAME,
            script: currentJob.script || undefined,
          },
          (proc, containerName) =>
            deps.onProcess(
              execution.executionJid,
              proc,
              containerName,
              execution.group.folder,
            ),
          async (streamedOutput: AgentOutput) => {
            if (streamedOutput.result) {
              result = streamedOutput.result;
              collectedResult += streamedOutput.result;
              if (await deliverStreamingChunk(streamedOutput.result)) {
                deliveredAnyOutput = true;
              }
              scheduleClose();
            }
            if (streamedOutput.status === 'success') {
              if (await finalizeStreaming()) deliveredAnyOutput = true;
              deps.queue.notifyIdle(execution.executionJid);
              scheduleClose();
            }
            if (streamedOutput.status === 'error') {
              error = streamedOutput.error || 'Unknown error';
              if (await finalizeStreaming()) deliveredAnyOutput = true;
            }
          },
          { timeoutMs },
        );

        if (output.status === 'error') {
          error = output.error || 'Unknown error';
        } else if (output.result) {
          result = output.result;
          if (!collectedResult) collectedResult = output.result;
        }

        if (!error) {
          const fallbackText = result || collectedResult;
          if (fallbackText && !deliveredAnyOutput) {
            if (await deliverMessage(fallbackText)) {
              deliveredAnyOutput = true;
            }
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        await finalizeStreaming();
        if (closeTimer && error) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
      }
    }
  }

  const now = new Date().toISOString();
  const nextRunOnSuccess = computeNextJobRun(currentJob, scheduledFor);
  let runStatus: 'completed' | 'failed' | 'timeout' | 'dead_lettered' =
    'completed';
  let nextRun: string | null = nextRunOnSuccess;
  let retryCount = currentJob.consecutive_failures;
  let pauseReason: string | null = null;

  if (error) {
    retryCount += 1;
    runStatus = /timed out/i.test(error) ? 'timeout' : 'failed';
    const exceededRetry = retryCount > currentJob.max_retries;
    const exceededConsecutive =
      retryCount >= currentJob.max_consecutive_failures;
    if (exceededRetry || exceededConsecutive) {
      runStatus = 'dead_lettered';
      nextRun = null;
      pauseReason = `Paused after ${retryCount} failures. Last error: ${error}`;
      updateJob(currentJob.id, {
        status: 'dead_lettered',
        next_run: null,
        last_run: now,
        consecutive_failures: retryCount,
        pause_reason: pauseReason,
        lease_run_id: null,
        lease_expires_at: null,
      });
    } else {
      const baseBackoff = Math.max(0, currentJob.retry_backoff_ms || 0);
      const exponent = Math.max(0, retryCount - 1);
      const cappedExponent = Math.min(exponent, 30);
      const multiplier = Math.max(1, 2 ** cappedExponent);
      const rawDelay = baseBackoff * multiplier;
      const boundedDelay = Number.isFinite(rawDelay)
        ? Math.min(rawDelay, 30 * 24 * 60 * 60 * 1000)
        : 30 * 24 * 60 * 60 * 1000;
      nextRun = new Date(Date.now() + boundedDelay).toISOString();
      updateJob(currentJob.id, {
        status: 'active',
        next_run: nextRun,
        last_run: now,
        consecutive_failures: retryCount,
        pause_reason: null,
        lease_run_id: null,
        lease_expires_at: null,
      });
    }
  } else {
    updateJob(currentJob.id, {
      status: nextRunOnSuccess ? 'active' : 'completed',
      next_run: nextRunOnSuccess,
      last_run: now,
      consecutive_failures: 0,
      pause_reason: null,
      lease_run_id: null,
      lease_expires_at: null,
    });
  }

  const resultSummary = result || collectedResult || null;
  completeJobRun(
    runId,
    runStatus,
    resultSummary ? resultSummary.slice(0, 500) : null,
    error ? error.slice(0, 500) : null,
  );

  addJobEvent({
    job_id: currentJob.id,
    run_id: runId,
    event_type: `run_${runStatus}`,
    payload: JSON.stringify({
      next_run: nextRun,
      retry_count: retryCount,
      pause_reason: pauseReason,
    }),
    created_at: now,
  });

  const summary = error
    ? error.slice(0, 240)
    : resultSummary
      ? resultSummary.slice(0, 4000)
      : 'Completed';
  let notified = false;
  if (error && !currentJob.silent) {
    const delivered = await deliverMessage(
      `⚠️ Scheduled task failed: ${summary}`,
    );
    notified = notified || delivered;
  }
  if (runStatus !== 'completed' && !currentJob.silent) {
    const message = formatRunStatusMessage({
      job: currentJob,
      runId,
      runStatus,
      summary,
      nextRun,
      retryCount,
      pauseReason,
    });
    const delivered = await notifyLinkedSessions(
      currentJob,
      message,
      deps.sendMessage,
    );
    notified = notified || delivered;
  }
  if (notified) {
    markJobRunNotified(runId);
  }
  deps.onSchedulerChanged?.();

  if (!error && !ranSystemJob) {
    try {
      await MemoryService.getInstance().reflectAfterTurn({
        groupFolder: execution.group.folder,
        prompt: currentJob.prompt,
        result: resultSummary || 'Completed',
        isMain,
        retrievedItemIds,
      });
    } catch (err) {
      logger.warn(
        { err, jobId: currentJob.id },
        'Memory reflection failed after job completion',
      );
    }
  }

  if (
    currentJob.schedule_type === 'once' &&
    (runStatus === 'completed' || runStatus === 'dead_lettered') &&
    normalizeCleanupAfterMs(currentJob.cleanup_after_ms) === 0
  ) {
    deleteJob(currentJob.id);
    deps.onSchedulerChanged?.();
  }
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      registerSystemJobs(deps);

      const released = releaseStaleJobLeases();
      if (released > 0) {
        logger.warn({ count: released }, 'Released stale scheduler leases');
        deps.onSchedulerChanged?.();
      }

      const dueJobs = listDueJobs();
      if (dueJobs.length > 0) {
        logger.info({ count: dueJobs.length }, 'Found due scheduler jobs');
      }

      for (const job of dueJobs) {
        const current = getJobById(job.id);
        if (!current || current.status !== 'active') continue;
        const queueJid =
          current.linked_sessions[0] || `${current.group_scope}:job`;
        deps.queue.enqueueTask(queueJid, current.id, () =>
          runJob(current, deps),
        );
      }

      const removed = sweepCompletedOneTimeJobs();
      if (removed) {
        deps.onSchedulerChanged?.();
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
