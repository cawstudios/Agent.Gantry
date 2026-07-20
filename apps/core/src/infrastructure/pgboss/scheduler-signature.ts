import type { Job } from '../../domain/types.js';
import { staleOnceRequeueBucket } from '../../shared/scheduler-job-staleness.js';
import { schedulerDeliveryPriorityForJob } from './scheduler-admission.js';

const STALE_ONCE_REENQUEUE_THROTTLE_MS = 60_000;

export function schedulerScheduleSignature(
  job: Job,
  nowMs: number,
  defaultTimezone: string,
): string {
  return JSON.stringify({
    id: job.id,
    status: job.status,
    scheduleType: job.schedule_type,
    scheduleValue: job.schedule_value,
    scheduleTimezone: job.schedule_timezone ?? defaultTimezone,
    misfirePolicy: job.misfire_policy ?? null,
    overlapPolicy: job.overlap_policy ?? null,
    scheduleMetadata: job.schedule_metadata ?? null,
    nextRun: job.schedule_type === 'cron' ? null : job.next_run,
    staleOnceRequeueBucket: staleOnceRequeueBucket(
      job,
      nowMs,
      STALE_ONCE_REENQUEUE_THROTTLE_MS,
    ),
    workspaceKey: job.workspace_key,
    admissionPriority: schedulerDeliveryPriorityForJob(job),
  });
}
