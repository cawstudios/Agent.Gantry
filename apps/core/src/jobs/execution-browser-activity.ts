import {
  createJobRunDiagnostics,
  requiredToolMatchesForRun,
} from './execution-diagnostics.js';
import type { SchedulerDependencies } from './types.js';

const POST_RUN_TOOL_ACTIVITY_TIMEOUT_MS = 5_000;

export async function requiredToolMatchesForRunBestEffort(input: {
  deps: SchedulerDependencies;
  jobId: string;
  runId: string;
  diagnostics: ReturnType<typeof createJobRunDiagnostics>;
  log: { warn: (context: Record<string, unknown>, message: string) => void };
}): Promise<string[] | null> {
  try {
    return await withTimeout(
      requiredToolMatchesForRun(input),
      POST_RUN_TOOL_ACTIVITY_TIMEOUT_MS,
      'Required tool activity verification',
    );
  } catch (err) {
    input.log.warn(
      {
        err,
        jobId: input.jobId,
        runId: input.runId,
      },
      'Failed to verify scheduled job required tool activity after runner completion',
    );
    return null;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
