import { ApplicationError } from '../common/application-error.js';
import type {
  CreateManagedJobInput,
  JobManagementServiceDeps,
} from './job-management-types.js';
import type { JobUpsertInput } from '../../domain/repositories/ops-repo.js';
import {
  assertJobModelHarnessCompatible,
  resolveRequestedJobModel,
} from './job-model-selection.js';
import {
  normalizeExecutionContext,
  normalizeNotificationRoutes,
  assertPublicJobNamespace,
  requireJobNotificationRouteApproval,
  routesBeyondAuthenticatedContext,
} from './job-management-helpers.js';
import { normalizeAccessRequirements } from './job-access-requirements.js';
import {
  evaluateJobReadiness,
  SETUP_REQUIRED_PAUSE_REASON,
} from './job-readiness-service.js';
import { recordJobSetupRequired } from './job-management-readiness.js';

export async function createManagedJob(
  deps: JobManagementServiceDeps,
  input: CreateManagedJobInput,
) {
  if (!deps.control) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Job control repository unavailable',
    );
  }
  const session = await deps.control.getAppSessionById(input.sessionId);
  if (!input.name.trim() || !input.prompt.trim() || !session) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'name, prompt, and sessionId are required',
    );
  }
  if (session.appId !== input.appId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'API key cannot access this session',
    );
  }
  assertPublicJobNamespace({ prompt: input.prompt });

  const kind = input.kind ?? 'manual';
  const schedule = deps.schedulePlanner.planAppSchedule({
    kind,
    runAt: input.runAt,
    schedule: input.schedule,
  });
  const recurringSchedulePolicy = normalizeRecurringSchedulePolicy(
    kind,
    input.schedule,
    deps.schedulePlanner.defaultTimezone,
  );
  const workload = kind === 'recurring' ? 'recurring_job' : 'one_time_job';
  const modelAlias = resolveRequestedJobModel(input.modelAlias, workload);
  const effectiveModelAlias =
    modelAlias ?? resolveRequestedJobModel(input.effectiveModelAlias, workload);
  assertJobModelHarnessCompatible({
    modelAlias: effectiveModelAlias,
    workload,
    agentHarness: input.agentHarness,
  });
  const jobId = deps.schedulePlanner.createManualJobId();
  const sessionBoundContext = {
    conversationJid: session.conversationJid,
    workspaceKey: session.workspaceKey,
  };
  const executionContext =
    input.executionContext !== undefined
      ? normalizeExecutionContext(input.executionContext)
      : {
          ...sessionBoundContext,
          threadId: null,
          sessionId: session.sessionId,
        };
  if (
    executionContext.conversationJid !== sessionBoundContext.conversationJid ||
    executionContext.workspaceKey !== sessionBoundContext.workspaceKey
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'executionContext must match authenticated job context.',
    );
  }
  if (
    executionContext.sessionId !== undefined &&
    executionContext.sessionId !== session.sessionId
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'executionContext.sessionId must match the authenticated app session.',
    );
  }
  const runtimeContext = {
    sessionId: session.sessionId,
    conversationJid: session.conversationJid,
    workspaceKey: session.workspaceKey,
    threadId: executionContext.threadId ?? null,
  };
  const notificationRoutes = normalizeNotificationRoutes(
    input.notificationRoutes ?? [
      {
        conversationJid: sessionBoundContext.conversationJid,
        threadId: executionContext.threadId ?? null,
        label: 'primary',
      },
    ],
  );
  const accessRequirements = normalizeAccessRequirements(
    input.accessRequirements ?? [],
  );
  const authenticatedContext = {
    ...sessionBoundContext,
    threadId: executionContext.threadId ?? null,
  };
  const routesBeyondContext = routesBeyondAuthenticatedContext({
    routes: notificationRoutes,
    authenticatedContext,
  });
  const jobInput: JobUpsertInput = {
    id: jobId,
    app_id: session.appId,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    model: modelAlias ?? null,
    schedule_type: schedule.scheduleType,
    schedule_value: schedule.scheduleValue,
    ...recurringSchedulePolicy,
    status: 'active',
    session_id: session.sessionId,
    thread_id: executionContext.threadId ?? null,
    workspace_key: session.workspaceKey,
    created_by: 'human',
    next_run: schedule.nextRun,
    execution_context: executionContext,
    notification_routes: notificationRoutes,
    access_requirements: accessRequirements,
    ...(input.agentTask
      ? {
          timeout_ms: input.agentTask.executionPolicy.totalTimeoutMs,
          agent_task: input.agentTask,
        }
      : {}),
  };
  const readiness = await evaluateJobReadiness({
    job: jobInput,
    appId: session.appId,
    toolRepository: deps.toolRepository,
    skillRepository: deps.skillRepository,
    mcpServerRepository: deps.mcpServerRepository,
    capabilitySecretRepository: deps.capabilitySecretRepository,
    credentialBroker: await deps.getCredentialBroker?.(),
    getBrowserStatus: deps.getBrowserStatus,
    clock: deps.clock,
  });
  if (input.dryRun === true) {
    return {
      jobId,
      created: false,
      modelAlias,
      runtimeContext,
      setupState: readiness.setupState,
      status: readiness.ready ? 'active' : 'paused',
      pauseReason: readiness.ready ? null : SETUP_REQUIRED_PAUSE_REASON,
    };
  }
  await requireJobNotificationRouteApproval({
    deps: deps as never,
    request: {
      operation: 'create',
      jobId,
      jobName: input.name.trim(),
      authenticatedContext,
      requestedRoutes: notificationRoutes,
      existingRoutes: [],
      routesBeyondContext,
    },
  });
  const result = await deps.ops.upsertJob({
    ...jobInput,
    status: readiness.ready ? 'active' : 'paused',
    pause_reason: readiness.ready ? null : SETUP_REQUIRED_PAUSE_REASON,
    next_run: readiness.ready ? schedule.nextRun : null,
    setup_state: readiness.setupState,
  });
  if (!readiness.ready) {
    await recordJobSetupRequired({
      deps,
      job: jobInput,
      readiness,
      appId: session.appId,
    });
  }
  deps.scheduler.requestSchedulerSync(jobId);
  return {
    jobId,
    created: result.created,
    modelAlias,
    runtimeContext,
    setupState: readiness.setupState,
  };
}

function normalizeRecurringSchedulePolicy(
  kind: CreateManagedJobInput['kind'],
  schedule: CreateManagedJobInput['schedule'],
  defaultTimezone: string,
) {
  if (kind !== 'recurring') return {};
  const timezone = String(schedule?.timezone ?? defaultTimezone).trim();
  if (!isIanaTimezone(timezone)) {
    throw new ApplicationError(
      'INVALID_SCHEDULE',
      'Recurring schedules require a valid IANA timezone.',
    );
  }
  if (
    schedule?.misfirePolicy !== undefined &&
    schedule.misfirePolicy !== 'coalesce'
  ) {
    throw new ApplicationError(
      'INVALID_SCHEDULE',
      'Only the coalesce misfire policy is supported.',
    );
  }
  if (
    schedule?.overlapPolicy !== undefined &&
    schedule.overlapPolicy !== 'skip'
  ) {
    throw new ApplicationError(
      'INVALID_SCHEDULE',
      'Only the skip overlap policy is supported.',
    );
  }
  const metadata = schedule?.metadata;
  let normalizedMetadata:
    | { scheduleId: string; generation: number }
    | undefined;
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new ApplicationError(
        'INVALID_SCHEDULE',
        'Schedule metadata must be an object.',
      );
    }
    const value = metadata as Record<string, unknown>;
    const scheduleId = String(value.scheduleId ?? '').trim();
    const generation = value.generation;
    if (
      !scheduleId ||
      !Number.isInteger(generation) ||
      Number(generation) < 1
    ) {
      throw new ApplicationError(
        'INVALID_SCHEDULE',
        'Schedule metadata requires scheduleId and a positive generation.',
      );
    }
    normalizedMetadata = { scheduleId, generation: Number(generation) };
  }
  return {
    schedule_timezone: timezone,
    misfire_policy: 'coalesce' as const,
    overlap_policy: 'skip' as const,
    ...(normalizedMetadata ? { schedule_metadata: normalizedMetadata } : {}),
  };
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
