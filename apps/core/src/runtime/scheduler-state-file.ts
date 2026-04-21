import fs from 'fs';
import path from 'path';

import { SCHEDULER_JOBS_JSON_PATH } from '../core/config.js';
import { nowIso } from '../core/datetime.js';
import { writeFileAtomic } from '../core/fs-paths.js';
import { Job, JobEvent, JobRun } from '../core/types.js';
import { logger } from '../core/logger.js';

export function writeSchedulerStateFile(
  jobs: Job[],
  runs: JobRun[],
  events: JobEvent[],
  filePath: string = SCHEDULER_JOBS_JSON_PATH,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const payload = {
    updated_at: nowIso(),
    jobs,
    recent_runs: runs,
    recent_events: events,
  };

  writeFileAtomic(filePath, JSON.stringify(payload, null, 2));
}

export function writeSchedulerStateFileSafe(
  jobs: Job[],
  runs: JobRun[],
  events: JobEvent[],
): void {
  try {
    writeSchedulerStateFile(jobs, runs, events);
  } catch (err) {
    logger.warn({ err }, 'Failed to write scheduler state JSON');
  }
}
