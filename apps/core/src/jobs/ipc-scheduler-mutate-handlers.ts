import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config/index.js';
import {
  nowIso,
  nowMs,
  parseIso,
  toIso,
} from '../infrastructure/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { Job } from '../domain/types.js';
import { TaskHandler } from './ipc-types.js';
import { invalidateSystemJobRegistrationSignature } from './system-registration-cache.js';
import {
  createTaskResponder,
  jobBelongsToAuthThread,
  jobBelongsToSourceGroup,
  normalizeIpcExecutionMode,
  toTrimmedString,
} from './ipc-shared.js';

function computeResumeNextRun(job: {
  id: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
}): string | null {
  if (job.next_run) return job.next_run;

  if (job.schedule_type === 'once') {
    const date = parseIso(job.schedule_value);
    return date ? nowIso() : null;
  }

  if (job.schedule_type === 'cron') {
    try {
      CronExpressionParser.parse(job.schedule_value, { tz: TIMEZONE });
      return nowIso();
    } catch {
      return null;
    }
  }

  if (job.schedule_type === 'interval') {
    const ms = parseInt(job.schedule_value, 10);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return nowIso();
  }

  return null;
}

const schedulerUpdateJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_update_job requires jobId.', 'invalid_request');
    return;
  }

  try {
    const job = await deps.opsRepository.getJobById(jobId);
    if (!job) {
      reject(`Scheduler job not found (${jobId}).`, 'not_found');
      return;
    }
    if (!jobBelongsToAuthThread(job, data.authThreadId)) {
      logger.warn(
        {
          sourceGroup,
          jobId,
          jobThreadId: job.thread_id,
          authThreadId: data.authThreadId,
        },
        'Unauthorized scheduler_update_job thread mutation blocked',
      );
      reject('Job belongs to a different thread.', 'forbidden');
      return;
    }
    if (
      !isMain &&
      !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)
    ) {
      logger.warn(
        {
          sourceGroup,
          groupScope: job.group_scope,
          linkedSessions: job.linked_sessions,
          jobId,
        },
        'Unauthorized scheduler_update_job attempt blocked',
      );
      reject('Job does not belong to this source group.', 'forbidden');
      return;
    }

    const updates: Partial<Job> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.prompt !== undefined) updates.prompt = data.prompt;
    if (data.model !== undefined) updates.model = data.model;
    if (data.script !== undefined) {
      logger.warn(
        { sourceGroup, jobId },
        'Rejected scheduler_update_job script mutation from IPC',
      );
      reject(
        'script mutation is not allowed for scheduler_update_job.',
        'forbidden',
      );
      return;
    }
    if (data.scheduleType !== undefined) {
      if (
        data.scheduleType !== 'cron' &&
        data.scheduleType !== 'interval' &&
        data.scheduleType !== 'once'
      ) {
        logger.warn(
          { sourceGroup, jobId, scheduleType: data.scheduleType },
          'Rejected scheduler_update_job with unsupported scheduleType',
        );
        reject('Unsupported schedule type.', 'invalid_schedule');
        return;
      }
      updates.schedule_type = data.scheduleType;
    }
    if (data.scheduleValue !== undefined) {
      updates.schedule_value = data.scheduleValue;
    }
    if (data.groupScope !== undefined) {
      if (!isMain && data.groupScope !== sourceGroup) {
        logger.warn(
          { sourceGroup, requestedGroupScope: data.groupScope, jobId },
          'Unauthorized group scope mutation in scheduler_update_job',
        );
        reject(
          'Only the main agent can set groupScope outside the source group.',
          'forbidden',
        );
        return;
      }
      updates.group_scope = data.groupScope;
    }
    if (typeof data.timeoutMs === 'number') updates.timeout_ms = data.timeoutMs;
    if (typeof data.maxRetries === 'number') {
      updates.max_retries = data.maxRetries;
    }
    if (typeof data.retryBackoffMs === 'number') {
      updates.retry_backoff_ms = data.retryBackoffMs;
    }
    if (typeof data.maxConsecutiveFailures === 'number') {
      updates.max_consecutive_failures = data.maxConsecutiveFailures;
    }
    if (typeof data.silent === 'boolean') updates.silent = data.silent;
    if (typeof data.cleanupAfterMs === 'number') {
      updates.cleanup_after_ms = data.cleanupAfterMs;
    }
    if (data.executionMode !== undefined || data.serialize !== undefined) {
      updates.execution_mode = normalizeIpcExecutionMode(
        data.executionMode,
        data.serialize,
        job.execution_mode,
      );
    }
    if (data.threadId !== undefined) {
      const requestedThreadId =
        typeof data.threadId === 'string' && data.threadId.trim()
          ? data.threadId.trim()
          : null;
      const authThreadId =
        typeof data.authThreadId === 'string' && data.authThreadId.trim()
          ? data.authThreadId.trim()
          : undefined;
      const currentThreadId = job.thread_id || null;
      const threadMutationAllowed = authThreadId
        ? requestedThreadId === authThreadId
        : requestedThreadId === null && currentThreadId === null;
      if (!threadMutationAllowed) {
        logger.warn(
          {
            sourceGroup,
            jobId,
            requestedThreadId,
            authThreadId,
            currentThreadId,
          },
          'Rejected scheduler_update_job with unauthorized thread mutation',
        );
        reject(
          'threadId payload does not match authenticated thread binding.',
          'forbidden',
        );
        return;
      }
      updates.thread_id = requestedThreadId;
    }
    if (Array.isArray(data.linkedSessions) || Array.isArray(data.deliverTo)) {
      const source = Array.isArray(data.deliverTo)
        ? data.deliverTo
        : data.linkedSessions || [];
      const linked = source.map((item) => String(item));
      if (!isMain) {
        const unauthorized = linked.some((jid) => {
          const group = registeredGroups[jid];
          return !group || group.folder !== sourceGroup;
        });
        if (unauthorized) {
          logger.warn(
            { sourceGroup, linked },
            'Unauthorized linked sessions in scheduler_update_job',
          );
          reject(
            'linked_sessions must belong to the source group for non-main agents.',
            'forbidden',
          );
          return;
        }
      }
      updates.linked_sessions = linked;
    }

    const merged = { ...job, ...updates };
    if (
      updates.schedule_type !== undefined ||
      updates.schedule_value !== undefined
    ) {
      if (merged.schedule_type === 'cron') {
        try {
          const interval = CronExpressionParser.parse(merged.schedule_value, {
            tz: TIMEZONE,
          });
          updates.next_run = interval.next().toISOString();
        } catch {
          logger.warn(
            { jobId, value: merged.schedule_value },
            'Invalid cron in scheduler_update_job',
          );
          reject(
            'Invalid cron expression for scheduler job.',
            'invalid_schedule',
          );
          return;
        }
      } else if (merged.schedule_type === 'interval') {
        const ms = parseInt(merged.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          logger.warn(
            { jobId, value: merged.schedule_value },
            'Invalid interval in scheduler_update_job',
          );
          reject(
            'Invalid interval milliseconds for scheduler job.',
            'invalid_schedule',
          );
          return;
        }
        updates.next_run = toIso(nowMs() + ms);
      } else if (merged.schedule_type === 'once') {
        const date = parseIso(merged.schedule_value);
        if (!date) {
          logger.warn(
            { jobId, value: merged.schedule_value },
            'Invalid once timestamp in scheduler_update_job',
          );
          reject(
            'Invalid once timestamp for scheduler job.',
            'invalid_schedule',
          );
          return;
        }
        updates.next_run = toIso(date);
      } else {
        reject('Unsupported schedule type.', 'invalid_schedule');
        return;
      }
    }

    await deps.opsRepository.updateJob(jobId, updates);
    invalidateSystemJobRegistrationSignature(deps.opsRepository);
    deps.onSchedulerChanged(jobId);
    accept(`Scheduler job updated (${jobId}).`);
  } catch (err) {
    logger.error(
      { err, sourceGroup, jobId },
      'scheduler_update_job failed unexpectedly',
    );
    reject(
      err instanceof Error ? err.message : 'Failed to update scheduler job.',
      'internal_error',
    );
  }
};

const schedulerDeleteJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_delete_job requires jobId.', 'invalid_request');
    return;
  }

  try {
    const job = await deps.opsRepository.getJobById(jobId);
    if (!job) {
      reject(`Scheduler job not found (${jobId}).`, 'not_found');
      return;
    }
    if (!jobBelongsToAuthThread(job, data.authThreadId)) {
      logger.warn(
        {
          sourceGroup,
          jobId,
          jobThreadId: job.thread_id,
          authThreadId: data.authThreadId,
        },
        'Unauthorized scheduler_delete_job thread mutation blocked',
      );
      reject('Job belongs to a different thread.', 'forbidden');
      return;
    }
    if (
      !isMain &&
      !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)
    ) {
      logger.warn(
        {
          sourceGroup,
          groupScope: job.group_scope,
          linkedSessions: job.linked_sessions,
          jobId,
        },
        'Unauthorized scheduler_delete_job attempt blocked',
      );
      reject('Job does not belong to this source group.', 'forbidden');
      return;
    }
    await deps.opsRepository.deleteJob(jobId);
    invalidateSystemJobRegistrationSignature(deps.opsRepository);
    deps.onSchedulerChanged(jobId);
    accept(`Scheduler job deleted (${jobId}).`);
  } catch (err) {
    logger.error(
      { err, sourceGroup, jobId },
      'scheduler_delete_job failed unexpectedly',
    );
    reject(
      err instanceof Error ? err.message : 'Failed to delete scheduler job.',
      'internal_error',
    );
  }
};

const schedulerPauseJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_pause_job requires jobId.', 'invalid_request');
    return;
  }

  try {
    const job = await deps.opsRepository.getJobById(jobId);
    if (!job) {
      reject(`Scheduler job not found (${jobId}).`, 'not_found');
      return;
    }
    if (!jobBelongsToAuthThread(job, data.authThreadId)) {
      logger.warn(
        {
          sourceGroup,
          jobId,
          jobThreadId: job.thread_id,
          authThreadId: data.authThreadId,
        },
        'Unauthorized scheduler_pause_job thread mutation blocked',
      );
      reject('Job belongs to a different thread.', 'forbidden');
      return;
    }
    if (
      !isMain &&
      !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)
    ) {
      logger.warn(
        {
          sourceGroup,
          groupScope: job.group_scope,
          linkedSessions: job.linked_sessions,
          jobId,
        },
        'Unauthorized scheduler_pause_job attempt blocked',
      );
      reject('Job does not belong to this source group.', 'forbidden');
      return;
    }
    await deps.opsRepository.updateJob(jobId, {
      status: 'paused',
      pause_reason: 'Paused by user',
    });
    invalidateSystemJobRegistrationSignature(deps.opsRepository);
    deps.onSchedulerChanged(jobId);
    accept(`Scheduler job paused (${jobId}).`);
  } catch (err) {
    logger.error(
      { err, sourceGroup, jobId },
      'scheduler_pause_job failed unexpectedly',
    );
    reject(
      err instanceof Error ? err.message : 'Failed to pause scheduler job.',
      'internal_error',
    );
  }
};

const schedulerResumeJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_resume_job requires jobId.', 'invalid_request');
    return;
  }

  try {
    const job = await deps.opsRepository.getJobById(jobId);
    if (!job) {
      reject(`Scheduler job not found (${jobId}).`, 'not_found');
      return;
    }
    if (!jobBelongsToAuthThread(job, data.authThreadId)) {
      logger.warn(
        {
          sourceGroup,
          jobId,
          jobThreadId: job.thread_id,
          authThreadId: data.authThreadId,
        },
        'Unauthorized scheduler_resume_job thread mutation blocked',
      );
      reject('Job belongs to a different thread.', 'forbidden');
      return;
    }
    if (
      !isMain &&
      !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)
    ) {
      logger.warn(
        {
          sourceGroup,
          groupScope: job.group_scope,
          linkedSessions: job.linked_sessions,
          jobId,
        },
        'Unauthorized scheduler_resume_job attempt blocked',
      );
      reject('Job does not belong to this source group.', 'forbidden');
      return;
    }
    const nextRun = computeResumeNextRun({
      id: job.id,
      schedule_type: String(job.schedule_type),
      schedule_value: job.schedule_value,
      next_run: job.next_run,
    });
    if (!nextRun) {
      const pauseReason = `Cannot resume with invalid schedule configuration (${job.schedule_type}:${job.schedule_value}).`;
      logger.warn(
        { sourceGroup, jobId, pauseReason },
        'Rejected scheduler_resume_job due to invalid schedule config',
      );
      await deps.opsRepository.updateJob(jobId, {
        status: 'dead_lettered',
        pause_reason: pauseReason,
        next_run: null,
      });
      invalidateSystemJobRegistrationSignature(deps.opsRepository);
      deps.onSchedulerChanged(jobId);
      reject(
        'Cannot resume scheduler job due to invalid schedule.',
        'invalid_schedule',
        [pauseReason, 'Job has been moved to dead_lettered state.'],
      );
      return;
    }
    await deps.opsRepository.updateJob(jobId, {
      status: 'active',
      pause_reason: null,
      next_run: nextRun,
    });
    invalidateSystemJobRegistrationSignature(deps.opsRepository);
    deps.onSchedulerChanged(jobId);
    accept(`Scheduler job resumed (${jobId}).`);
  } catch (err) {
    logger.error(
      { err, sourceGroup, jobId },
      'scheduler_resume_job failed unexpectedly',
    );
    reject(
      err instanceof Error ? err.message : 'Failed to resume scheduler job.',
      'internal_error',
    );
  }
};

export const schedulerMutateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_update_job: schedulerUpdateJobHandler,
  scheduler_delete_job: schedulerDeleteJobHandler,
  scheduler_pause_job: schedulerPauseJobHandler,
  scheduler_resume_job: schedulerResumeJobHandler,
};
