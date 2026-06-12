import {
  agentEngineLabel,
  DEFAULT_AGENT_ENGINE,
  type AgentEngine,
} from './agent-engine.js';
import type { ModelCatalogEntry } from './model-catalog.js';
import { listModelCatalogEntries } from './model-catalog.js';
import {
  getModelProviderDefinition,
  type ModelExecutionRoute,
} from './model-provider-registry.js';

export interface ResolvedExecutionRoute {
  route: ModelExecutionRoute;
  executionProviderId: ModelExecutionRoute['executionProviderId'];
  supportedCredentialModes: readonly string[];
}

export type ExecutionRouteResolution =
  | { ok: true; value: ResolvedExecutionRoute }
  | { ok: false; reason: 'incompatible-engine'; message: string };

// Resolves `modelAlias + agentEngine -> executionRoute`. The entry already
// carries the resolved model alias and its provider route; this picks the
// execution adapter for the agent's engine or returns a typed incompatibility
// error with the locked plan copy. Credential-mode rejection happens later,
// where the bound credential mode is known, using `supportedCredentialModes`.
export function resolveExecutionRoute(input: {
  entry: ModelCatalogEntry;
  agentEngine: AgentEngine;
}): ExecutionRouteResolution {
  const { entry, agentEngine } = input;
  const provider = getModelProviderDefinition(entry.modelRoute.id);
  if (!provider) {
    return {
      ok: false,
      reason: 'incompatible-engine',
      message: `Model ${entry.recommendedAlias} references unsupported provider route ${entry.modelRoute.id}.`,
    };
  }
  const route = provider.executionRoutes.find(
    (candidate) => candidate.engine === agentEngine,
  );
  if (route) {
    return {
      ok: true,
      value: {
        route,
        executionProviderId: route.executionProviderId,
        supportedCredentialModes: route.supportedCredentialModes,
      },
    };
  }
  return {
    ok: false,
    reason: 'incompatible-engine',
    message: incompatibleEngineMessage(entry, agentEngine, provider),
  };
}

function incompatibleEngineMessage(
  entry: ModelCatalogEntry,
  agentEngine: AgentEngine,
  provider: NonNullable<ReturnType<typeof getModelProviderDefinition>>,
): string {
  const alias = entry.recommendedAlias;
  if (
    agentEngine === DEFAULT_AGENT_ENGINE &&
    provider.responseFamily === 'openai'
  ) {
    return `Model ${alias} uses the OpenAI endpoint, which is not supported by Anthropic SDK. Choose DeepAgents or an Anthropic-compatible model.`;
  }
  const compatible = compatibleAliasesForEngine(agentEngine);
  const aliasList = compatible.length > 0 ? compatible.join(', ') : 'none';
  return `Model ${alias} cannot run with ${agentEngineLabel(agentEngine)}. Choose one of: ${aliasList}.`;
}

// Recommended aliases whose provider route exposes an execution route for the
// given engine. Used to populate the generic pair-incompatibility copy and to
// drive settings/CLI compatibility surfaces.
export function compatibleAliasesForEngine(
  agentEngine: AgentEngine,
): readonly string[] {
  const aliases: string[] = [];
  for (const entry of listModelCatalogEntries()) {
    const provider = getModelProviderDefinition(entry.modelRoute.id);
    if (!provider) continue;
    if (
      provider.executionRoutes.some((route) => route.engine === agentEngine)
    ) {
      aliases.push(entry.recommendedAlias);
    }
  }
  return aliases;
}
