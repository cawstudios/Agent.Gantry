import type { Job } from '../../domain/types.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import {
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
  type ModelResolution,
} from '../../shared/model-catalog.js';

export type JobModelDefaultConfig = {
  model?: string;
  source: string;
};

export interface ResolvedJobModel {
  selectedModel?: string;
  source: string;
  resolution?: ModelResolution;
  entry?: ModelCatalogEntry;
  defaultExecutionProviderId?: ExecutionProviderId;
}

export function modelUseKindForJobSchedule(
  scheduleType: Job['schedule_type'],
): 'oneTimeJob' | 'recurringJob' {
  return scheduleType === 'cron' || scheduleType === 'interval'
    ? 'recurringJob'
    : 'oneTimeJob';
}

export function jobModelWorkloadForSchedule(
  scheduleType: Job['schedule_type'],
): 'one_time_job' | 'recurring_job' {
  return modelUseKindForJobSchedule(scheduleType) === 'recurringJob'
    ? 'recurring_job'
    : 'one_time_job';
}

export function resolveDefaultJobExecutionProviderId(
  scheduleType: Job['schedule_type'],
): ExecutionProviderId | undefined {
  const resolution = resolveModelSelectionForWorkload(
    'opus',
    jobModelWorkloadForSchedule(scheduleType),
  );
  return resolution.ok
    ? (resolution.entry.executionProviderId as ExecutionProviderId)
    : undefined;
}

export function resolveJobModel(
  job: Pick<Job, 'model' | 'schedule_type'>,
  defaultConfig: JobModelDefaultConfig,
): ResolvedJobModel {
  const selectedModel = job.model || defaultConfig.model;
  const defaultResolution = defaultConfig.model
    ? resolveModelSelectionForWorkload(
        defaultConfig.model,
        jobModelWorkloadForSchedule(job.schedule_type),
      )
    : undefined;
  const resolution = selectedModel
    ? resolveModelSelectionForWorkload(
        selectedModel,
        jobModelWorkloadForSchedule(job.schedule_type),
      )
    : undefined;
  return {
    selectedModel,
    source: job.model ? 'job.model' : defaultConfig.source,
    resolution,
    entry: resolution?.ok ? resolution.entry : undefined,
    defaultExecutionProviderId: defaultResolution?.ok
      ? (defaultResolution.entry.executionProviderId as ExecutionProviderId)
      : undefined,
  };
}
