import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import {
  resolveAgentToolRuntimePolicy,
  resolveAgentToolRuntimeRules,
} from '../application/agents/agent-tool-runtime-rules.js';

export interface ConfiguredAgentToolPolicy {
  allowedTools: string[] | undefined;
  localCliCredentialAccess: boolean;
  localCliCredentialPaths: string[];
  localCliNetworkHosts: string[];
}

export async function resolveConfiguredAllowedTools(input: {
  repository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<string[] | undefined> {
  if (!input.repository) return undefined;
  return resolveAgentToolRuntimeRules({
    repository: input.repository,
    appId: input.appId,
    agentId: input.agentId,
    errorSubject: 'Configured agent tool',
    skillRepository: input.skillRepository,
  });
}

export async function resolveConfiguredToolPolicy(input: {
  repository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<ConfiguredAgentToolPolicy> {
  if (!input.repository) {
    return {
      allowedTools: undefined,
      localCliCredentialAccess: false,
      localCliCredentialPaths: [],
      localCliNetworkHosts: [],
    };
  }
  const policy = await resolveAgentToolRuntimePolicy({
    repository: input.repository,
    appId: input.appId,
    agentId: input.agentId,
    errorSubject: 'Configured agent tool',
    skillRepository: input.skillRepository,
  });
  return {
    allowedTools: policy.rules,
    localCliCredentialAccess: policy.localCliCredentialAccess,
    localCliCredentialPaths: policy.localCliCredentialPaths,
    localCliNetworkHosts: policy.localCliNetworkHosts,
  };
}
