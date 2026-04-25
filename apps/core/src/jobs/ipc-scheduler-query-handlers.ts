import { logger } from '../infrastructure/logging/logger.js';
import { TaskHandler } from './ipc-types.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';

const DEFAULT_RUN_LIMIT = 50;
const DEFAULT_EVENT_LIMIT = 200;
const DEFAULT_DEAD_LETTER_LIMIT = 50;
const MAX_QUERY_LIMIT = 1_000;

function resolveLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const normalized = Math.floor(raw);
  if (normalized <= 0) return fallback;
  return Math.min(normalized, MAX_QUERY_LIMIT);
}

const schedulerListRunsHandler: TaskHandler = async ({
  data,
  sourceGroup,
  deps,
}) => {
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const limit = resolveLimit(data.limit, DEFAULT_RUN_LIMIT);
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  try {
    const runs = await deps.opsRepository.listJobRuns(
      jobId || undefined,
      limit,
    );
    accept(`Listed ${runs.length} scheduler run(s).`);
  } catch (err) {
    logger.error(
      { err, sourceGroup, limit, jobId: jobId || undefined },
      'scheduler_list_runs failed unexpectedly',
    );
    reject(
      err instanceof Error ? err.message : 'Failed to list scheduler runs.',
      'internal_error',
    );
  }
};

const schedulerListEventsHandler: TaskHandler = async ({
  data,
  sourceGroup,
  deps,
}) => {
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const limit = resolveLimit(data.limit, DEFAULT_EVENT_LIMIT);
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  const runId = toTrimmedString(data.runId, { maxLen: 128 });
  const eventType = toTrimmedString(data.eventType, { maxLen: 128 });
  const sinceId =
    typeof data.sinceId === 'number' && Number.isFinite(data.sinceId)
      ? Math.max(0, Math.floor(data.sinceId))
      : undefined;
  try {
    const events = await deps.opsRepository.listRecentJobEvents(limit, {
      job_id: jobId || undefined,
      run_id: runId || undefined,
      event_type: eventType || undefined,
    });
    const visibleEvents =
      sinceId !== undefined
        ? events.filter((event) => event.id > sinceId)
        : events;
    accept(`Listed ${visibleEvents.length} scheduler event(s).`);
  } catch (err) {
    logger.error(
      {
        err,
        sourceGroup,
        limit,
        jobId: jobId || undefined,
        runId: runId || undefined,
        eventType: eventType || undefined,
        sinceId,
      },
      'scheduler_list_events failed unexpectedly',
    );
    reject(
      err instanceof Error ? err.message : 'Failed to list scheduler events.',
      'internal_error',
    );
  }
};

const schedulerGetDeadLetterHandler: TaskHandler = async ({
  data,
  sourceGroup,
  deps,
}) => {
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const limit = resolveLimit(data.limit, DEFAULT_DEAD_LETTER_LIMIT);
  try {
    const runs = await deps.opsRepository.listDeadLetterRuns(limit);
    accept(`Listed ${runs.length} dead-letter run(s).`);
  } catch (err) {
    logger.error(
      { err, sourceGroup, limit },
      'scheduler_get_dead_letter failed unexpectedly',
    );
    reject(
      err instanceof Error
        ? err.message
        : 'Failed to list dead-letter scheduler runs.',
      'internal_error',
    );
  }
};

export const schedulerQueryTaskHandlers: Record<string, TaskHandler> = {
  scheduler_list_runs: schedulerListRunsHandler,
  scheduler_list_events: schedulerListEventsHandler,
  scheduler_wait_for_events: schedulerListEventsHandler,
  scheduler_get_dead_letter: schedulerGetDeadLetterHandler,
};
