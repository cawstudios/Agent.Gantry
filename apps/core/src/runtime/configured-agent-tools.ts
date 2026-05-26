import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import {
  resolveAgentToolRuntimePolicy,
  resolveAgentToolRuntimeRules,
} from '../application/agents/agent-tool-runtime-rules.js';
import type {
  CapabilityRuntimeAccess,
  LocalCliNetworkBinding,
} from '../shared/capability-runtime-access.js';

export interface ConfiguredAgentToolPolicy {
  allowedTools: string[] | undefined;
  runtimeAccess: CapabilityRuntimeAccess[];
  localCliCredentialAccess: boolean;
  localCliCredentialPaths: string[];
  localCliNetworkBindings: LocalCliNetworkBinding[];
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
      runtimeAccess: [],
      localCliCredentialAccess: false,
      localCliCredentialPaths: [],
      localCliNetworkBindings: [],
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
    runtimeAccess: policy.runtimeAccess,
    localCliCredentialAccess: policy.localCliCredentialAccess,
    localCliCredentialPaths: policy.localCliCredentialPaths,
    localCliNetworkBindings: policy.localCliNetworkBindings,
  };
}
