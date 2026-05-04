import type { Job, JobRunStatus } from '../domain/types.js';
import type { SchedulerSendMessage } from './delivery.js';
import { notifyLinkedSessions } from './delivery.js';
import { formatRunStatusMessage } from './status-formatting.js';
import { MEMORY_DREAM_SYSTEM_PROMPT } from './system-jobs.js';

export function logMemoryDreamJobFailure(input: {
  job: Job;
  runId: string;
  error: string | null;
  logger: {
    error(payload: Record<string, unknown>, message: string): void;
  };
}): void {
  if (!input.error || input.job.prompt !== MEMORY_DREAM_SYSTEM_PROMPT) return;
  input.logger.error(
    {
      jobId: input.job.id,
      groupScope: input.job.group_scope,
      runId: input.runId,
      error: input.error,
    },
    'Memory dreaming system job failed',
  );
}

export async function notifySchedulerRunFailure(input: {
  job: Job;
  runId: string;
  runStatus: Extract<JobRunStatus, 'failed' | 'timeout' | 'dead_lettered'>;
  summary: string;
  nextRun: string | null;
  retryCount: number;
  pauseReason: string | null;
  sendMessage: SchedulerSendMessage;
  deliverMessage: (text: string) => Promise<boolean>;
  error: string | null;
}): Promise<boolean> {
  let notified = false;
  if (input.error && !input.job.silent) {
    notified =
      (await input.deliverMessage(
        `⚠️ Scheduled task failed: ${input.summary}`,
      )) || notified;
  }
  if (input.job.silent) return notified;
  const message = formatRunStatusMessage({
    job: input.job,
    runId: input.runId,
    runStatus: input.runStatus,
    summary: input.summary,
    nextRun: input.nextRun,
    retryCount: input.retryCount,
    pauseReason: input.pauseReason,
  });
  return (
    (await notifyLinkedSessions(input.job, message, input.sendMessage)) ||
    notified
  );
}
