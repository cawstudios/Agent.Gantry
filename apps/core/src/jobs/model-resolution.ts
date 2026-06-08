import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import { resolveConfiguredRuntimeExecutionProviderId } from '../runtime/execution-provider-id.js';
import type { NormalizedModelUsage } from '../shared/model-catalog.js';
import {
  modelUseKindForJobSchedule,
  resolveDefaultJobExecutionProviderId,
  resolveJobModel,
  type ResolvedJobModel,
} from '../application/jobs/job-model-resolution.js';

export type { NormalizedModelUsage };
export {
  modelUseKindForJobSchedule,
  resolveDefaultJobExecutionProviderId,
  resolveJobModel,
};

export function resolveJobExecutionProviderId(input: {
  resolvedModel: ResolvedJobModel;
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
  executionAdapters?: Pick<AgentExecutionAdapterRegistry, 'list'>;
  fallbackForInjectedRunner?: boolean;
}): ExecutionProviderId {
  return (
    (input.resolvedModel.entry?.executionProviderId as
      | ExecutionProviderId
      | undefined) ??
    resolveConfiguredRuntimeExecutionProviderId({
      executionAdapter: input.executionAdapter,
      executionAdapters: input.executionAdapters,
      fallbackExecutionProviderId: input.fallbackForInjectedRunner
        ? input.resolvedModel.defaultExecutionProviderId
        : undefined,
    })
  );
}

function modelAuditPayload(resolved: ResolvedJobModel) {
  return {
    resolved_model_alias: resolved.resolution?.ok
      ? resolved.resolution.alias
      : null,
    resolved_model_profile_id: resolved.entry?.id ?? null,
    model_source: resolved.source,
    cache_policy: resolved.entry?.cacheMode ?? 'unknown',
  };
}

export function jobStartedModelPayload(resolved: ResolvedJobModel) {
  return {
    ...modelAuditPayload(resolved),
    context_window_tokens: resolved.entry?.contextWindowTokens ?? null,
  };
}

export function jobCompletedModelPayload(
  resolved: ResolvedJobModel,
  usage?: NormalizedModelUsage,
) {
  return {
    usage,
    ...modelAuditPayload(resolved),
  };
}
