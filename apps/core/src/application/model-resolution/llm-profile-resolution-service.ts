import type { LlmProfile } from '../../domain/agent/agent.js';
import {
  resolveModelSelectionForWorkload,
  type ModelCapabilityDescriptor,
  type ModelCatalogEntry,
  type ModelExecutionProviderId,
  type ModelResponseFamily,
  type ModelRouteId,
  type ModelWorkload,
} from '../../shared/model-catalog.js';
import {
  DEFAULT_AGENT_ENGINE,
  type AgentEngine,
} from '../../shared/agent-engine.js';
import { resolveExecutionRoute } from '../../shared/model-execution-route.js';

export interface ResolvedLlmProfile {
  profile: LlmProfile;
  alias: string;
  modelEntry: ModelCatalogEntry;
  runnerModel: string;
  responseFamily: ModelResponseFamily;
  modelRoute: {
    id: ModelRouteId;
    label: string;
    metadata: {
      providerModelId: string;
    };
  };
  // Read-only diagnostic: the internal execution adapter the resolved
  // engine+route pairing runs on.
  executionProviderId: ModelExecutionProviderId;
  agentEngine: AgentEngine;
  supportedCredentialModes: readonly string[];
  credentialProfileRef: string;
  capabilities: ModelCapabilityDescriptor;
}

export type LlmProfileResolution =
  | { ok: true; value: ResolvedLlmProfile }
  | {
      ok: false;
      reason:
        | 'empty'
        | 'unknown'
        | 'raw-provider-id'
        | 'unsupported-workload'
        | 'incompatible-engine';
      message: string;
    };

export class LlmProfileResolutionService {
  resolve(input: {
    profile: LlmProfile;
    workload: ModelWorkload;
  }): LlmProfileResolution {
    const resolved = resolveModelSelectionForWorkload(
      input.profile.modelAlias,
      input.workload,
    );
    if (!resolved.ok) {
      return {
        ok: false,
        reason:
          resolved.reason === 'duplicate-alias' ? 'unknown' : resolved.reason,
        message: resolved.message,
      };
    }
    const agentEngine = input.profile.agentEngine ?? DEFAULT_AGENT_ENGINE;
    const executionRoute = resolveExecutionRoute({
      entry: resolved.entry,
      agentEngine,
    });
    if (!executionRoute.ok) {
      return {
        ok: false,
        reason: 'incompatible-engine',
        message: executionRoute.message,
      };
    }
    const credentialProfileRef =
      input.profile.credentialProfileRef ?? resolved.entry.credentialProfileRef;
    return {
      ok: true,
      value: {
        profile: input.profile,
        alias: resolved.alias,
        modelEntry: resolved.entry,
        runnerModel: resolved.runnerModel,
        responseFamily: resolved.entry.responseFamily,
        modelRoute: {
          id: resolved.entry.modelRoute.id,
          label: resolved.entry.modelRoute.label,
          metadata: {
            providerModelId: resolved.entry.modelRoute.providerModelId,
          },
        },
        executionProviderId: executionRoute.value.executionProviderId,
        agentEngine,
        supportedCredentialModes: executionRoute.value.supportedCredentialModes,
        credentialProfileRef,
        capabilities: resolved.entry.capabilities,
      },
    };
  }
}
