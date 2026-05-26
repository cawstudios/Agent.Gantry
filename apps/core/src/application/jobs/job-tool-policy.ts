import type { Job } from '../../domain/types.js';
import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';
import {
  resolveAgentToolRuntimePolicy,
  resolveAgentToolRuntimeRules,
} from '../agents/agent-tool-runtime-rules.js';
import type {
  CapabilityRuntimeAccess,
  LocalCliNetworkBinding,
} from '../../shared/capability-runtime-access.js';

export interface JobToolPolicyResolution {
  inheritedTools: string[];
  effectiveAllowedTools: string[];
  runtimeAccess: CapabilityRuntimeAccess[];
  localCliCredentialAccess: boolean;
  localCliCredentialPaths: string[];
  localCliNetworkBindings: LocalCliNetworkBinding[];
}

export function agentIdForJobGroupScope(groupScope: string): string {
  const trimmed = groupScope.trim();
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}

export async function resolveJobToolPolicy(input: {
  job: Job;
  appId?: string;
  agentId?: string;
  toolRepository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
}): Promise<JobToolPolicyResolution> {
  const inheritedTools =
    input.appId && input.agentId
      ? await resolveAgentToolBindingPolicy({
          repository: input.toolRepository,
          appId: input.appId,
          agentId: input.agentId,
          skillRepository: input.skillRepository,
        })
      : {
          rules: [],
          runtimeAccess: [],
          localCliCredentialAccess: false,
          localCliCredentialPaths: [],
          localCliNetworkBindings: [],
        };
  return {
    inheritedTools: inheritedTools.rules,
    effectiveAllowedTools: mergeUnique(inheritedTools.rules),
    runtimeAccess: inheritedTools.runtimeAccess,
    localCliCredentialAccess: inheritedTools.localCliCredentialAccess,
    localCliCredentialPaths: inheritedTools.localCliCredentialPaths,
    localCliNetworkBindings: inheritedTools.localCliNetworkBindings,
  };
}

export async function resolveAgentToolBindings(input: {
  repository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<string[]> {
  if (!input.repository) return [];
  return resolveAgentToolRuntimeRules({
    repository: input.repository,
    appId: input.appId,
    agentId: input.agentId,
    errorSubject: 'Inherited agent tool',
    skillRepository: input.skillRepository,
    makeError: (message) => new ApplicationError('FORBIDDEN', message),
  });
}

export async function resolveAgentToolBindingPolicy(input: {
  repository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<{
  rules: string[];
  runtimeAccess: CapabilityRuntimeAccess[];
  localCliCredentialAccess: boolean;
  localCliCredentialPaths: string[];
  localCliNetworkBindings: LocalCliNetworkBinding[];
}> {
  if (!input.repository) {
    return {
      rules: [],
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
    errorSubject: 'Inherited agent tool',
    skillRepository: input.skillRepository,
    makeError: (message) => new ApplicationError('FORBIDDEN', message),
  });
  return {
    rules: policy.rules,
    runtimeAccess: policy.runtimeAccess,
    localCliCredentialAccess: policy.localCliCredentialAccess,
    localCliCredentialPaths: policy.localCliCredentialPaths,
    localCliNetworkBindings: policy.localCliNetworkBindings,
  };
}

function mergeUnique(base: readonly string[]): string[] {
  const out = new Set<string>();
  for (const item of base) {
    const value = item.trim();
    if (value) out.add(value);
  }
  return [...out];
}
