import type { Job } from '../../../../domain/repositories/domain-types.js';
import { parseJson } from '../repositories/canonical-graph-repository.postgres.js';

export interface CanonicalJobSchedule {
  type?: string;
  value?: string;
  timezone?: string;
  misfirePolicy?: 'coalesce';
  overlapPolicy?: 'skip';
  metadata?: { scheduleId: string; generation: number };
}

export function parseCanonicalJobSchedule(
  value: unknown,
): CanonicalJobSchedule {
  return parseJson<CanonicalJobSchedule>(value, {});
}

type CanonicalJobScheduleSource = Pick<
  Job,
  | 'schedule_type'
  | 'schedule_value'
  | 'schedule_timezone'
  | 'misfire_policy'
  | 'overlap_policy'
  | 'schedule_metadata'
>;

export function canonicalJobScheduleValue(
  job: CanonicalJobScheduleSource,
): CanonicalJobSchedule {
  return {
    type: job.schedule_type,
    value: job.schedule_value,
    ...(job.schedule_timezone ? { timezone: job.schedule_timezone } : {}),
    ...(job.misfire_policy ? { misfirePolicy: job.misfire_policy } : {}),
    ...(job.overlap_policy ? { overlapPolicy: job.overlap_policy } : {}),
    ...(job.schedule_metadata ? { metadata: job.schedule_metadata } : {}),
  };
}
