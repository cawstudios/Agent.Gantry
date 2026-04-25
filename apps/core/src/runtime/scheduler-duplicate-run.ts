import { Job } from '../core/types.js';
import { logger } from '../core/logger.js';
import { addJobEvent, updateJob } from '../storage/db.js';

export function skipDuplicateScheduledRun(
  job: Job,
  runId: string,
  scheduledFor: string,
  nextRun: string | null,
): void {
  const now = new Date().toISOString();
  const status = nextRun ? 'active' : 'completed';

  updateJob(job.id, {
    status,
    next_run: nextRun,
    last_run: now,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
  });

  try {
    addJobEvent({
      job_id: job.id,
      run_id: runId,
      event_type: 'job.duplicate_scheduled_run_skipped',
      payload: JSON.stringify({
        scheduled_for: scheduledFor,
        next_run: nextRun,
        status,
      }),
      created_at: now,
    });
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, runId },
      'Failed to write duplicate scheduler run event',
    );
  }
}
