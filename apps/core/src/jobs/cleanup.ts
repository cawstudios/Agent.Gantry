import type { SchedulerDependencies } from './types.js';

export const DEFAULT_JOB_CLEANUP_AFTER_MS = 86_400_000;

export function normalizeCleanupAfterMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_JOB_CLEANUP_AFTER_MS;
  }
  return Math.max(0, Math.round(value));
}

export async function sweepCompletedOneTimeJobs(
  deps: SchedulerDependencies,
): Promise<boolean> {
  const removed = await deps.opsRepository.deleteExpiredCompletedOneTimeJobs();
  return removed > 0;
}
