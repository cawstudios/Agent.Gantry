import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { RuntimeEventType } from '../domain/events/runtime-event-types.js';
import type { JobRunDiagnostics } from './execution-diagnostics.js';
import { requiredToolMatchesForRunBestEffort } from './execution-browser-activity.js';
import type { SchedulerDependencies } from './types.js';

export async function verifyRequiredToolUsageAfterRun(input: {
  deps: SchedulerDependencies;
  jobId: string;
  runId: string;
  requiredTools: readonly string[];
  diagnostics: JobRunDiagnostics;
  emitJobEvent: (
    eventType: RuntimeEventType,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  log: { warn: (context: Record<string, unknown>, message: string) => void };
}): Promise<
  | { status: 'verified' }
  | { status: 'skipped' }
  | { status: 'failed'; error: string }
> {
  const requiredTools = await latestRequiredTools(input);
  if (requiredTools.length === 0) return { status: 'verified' };
  const matchedRequiredTools = await requiredToolMatchesForRunBestEffort(input);
  if (matchedRequiredTools === null) {
    await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, {
      phase: 'required_tool_verification_skipped',
      required_tools: requiredTools,
      ok: true,
      reason:
        'Required tool activity verification timed out after the runner completed.',
    });
    return { status: 'skipped' };
  }

  input.diagnostics.requiredToolMatches = matchedRequiredTools;
  const missingRequiredTools = requiredTools.filter(
    (tool) => !matchedRequiredTools.includes(tool),
  );
  for (const matchedTool of matchedRequiredTools) {
    if (!requiredTools.includes(matchedTool)) continue;
    await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, {
      phase: 'required_tool_satisfied',
      tool: matchedTool,
      matched_required_tools: [matchedTool],
      ...(matchedTool === 'Browser'
        ? { browser_activity_count: input.diagnostics.browserActivityCount }
        : {}),
      ok: true,
    });
  }
  if (missingRequiredTools.length === 0) return { status: 'verified' };

  const error =
    `Required tools were available but not used: ${missingRequiredTools.join(', ')}. ` +
    'required_tools entries are must-use assertions, not permission requests; the run must exercise every listed required tool before completion.';
  await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, {
    phase: 'required_tool_unsatisfied',
    required_tools: requiredTools,
    missing_required_tools: missingRequiredTools,
    matched_required_tools: matchedRequiredTools,
    browser_activity_count: input.diagnostics.browserActivityCount,
    ok: false,
    error,
  });
  return { status: 'failed', error };
}

async function latestRequiredTools(input: {
  deps: SchedulerDependencies;
  jobId: string;
  requiredTools: readonly string[];
  log: { warn: (context: Record<string, unknown>, message: string) => void };
}): Promise<readonly string[]> {
  try {
    return (
      (await input.deps.opsRepository.getJobById(input.jobId))
        ?.required_tools ?? input.requiredTools
    );
  } catch (err) {
    input.log.warn(
      { err, jobId: input.jobId },
      'Failed to reload scheduled job required tools after runner completion',
    );
    return input.requiredTools;
  }
}
