import type { Job } from '../domain/types.js';

export function formatRunStatusMessage(args: {
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
