import type { Job } from '../../domain/types.js';
import type {
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';
import {
  resolveAgentToolRuntimePolicy,
  resolveAgentToolRuntimeRules,
} from '../agents/agent-tool-runtime-rules.js';
import type { CapabilityRuntimeAccess } from '../../shared/capability-runtime-access.js';
import { splitAccessRequirements } from './job-access-requirements.js';
import { reviewedMcpToolPatterns } from '../../shared/mcp-tool-scope.js';

export interface JobToolPolicyResolution {
  inheritedTools: string[];
  effectiveAllowedTools: string[];
  runtimeAccess: CapabilityRuntimeAccess[];
}

export function agentIdForJobWorkspaceKey(workspaceKey: string): string {
  const trimmed = workspaceKey.trim();
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}

export async function resolveJobToolPolicy(input: {
  job: Job;
  appId?: string;
  agentId?: string;
  toolRepository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  mcpServerRepository?: McpServerRepository;
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
        };
  const requiredMcpAccess =
    input.appId && input.agentId && input.mcpServerRepository
      ? await resolveRequiredMcpAccess({
          repository: input.mcpServerRepository,
          appId: input.appId,
          agentId: input.agentId,
          requiredServers: splitAccessRequirements(
            input.job.access_requirements,
          ).requiredMcpServers,
        })
      : { rules: [], runtimeAccess: [] };
  return {
    inheritedTools: inheritedTools.rules,
    effectiveAllowedTools: mergeUnique([
      ...inheritedTools.rules,
      ...requiredMcpAccess.rules,
    ]),
    runtimeAccess: [
      ...inheritedTools.runtimeAccess,
      ...requiredMcpAccess.runtimeAccess,
    ],
  };
}

async function resolveRequiredMcpAccess(input: {
  repository: McpServerRepository;
  appId: string;
  agentId: string;
  requiredServers: readonly string[];
}): Promise<{ rules: string[]; runtimeAccess: CapabilityRuntimeAccess[] }> {
  if (input.requiredServers.length === 0)
    return { rules: [], runtimeAccess: [] };
  const required = new Set(input.requiredServers);
  const records = await input.repository.listMaterializedServersForAgent({
    appId: input.appId as never,
    agentId: input.agentId as never,
  });
  const runtimeAccess: CapabilityRuntimeAccess[] = [];
  const rules: string[] = [];
  for (const { definition, binding } of records) {
    if (!required.has(definition.id) && !required.has(definition.name))
      continue;
    const patterns =
      binding.allowedToolPatterns.length > 0
        ? binding.allowedToolPatterns
        : reviewedMcpToolPatterns(definition);
    const allowedTools = patterns
      .filter((pattern) => /^[A-Za-z0-9_.-]+$/.test(pattern))
      .map((pattern) => `mcp__${definition.name}__${pattern}`);
    if (allowedTools.length === 0) continue;
    rules.push(...allowedTools);
    runtimeAccess.push({
      selectedCapabilityId: `mcp:${definition.name}`,
      sourceType: 'mcp_server',
      auditLabel: definition.displayName ?? definition.name,
      reviewedServerId: definition.id,
      allowedTools,
      credentialRefs: definition.credentialRefs.map((ref) => ref.name),
      networkHosts: [...definition.networkHosts],
    });
  }
  return { rules, runtimeAccess };
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
}> {
  if (!input.repository) {
    return {
      rules: [],
      runtimeAccess: [],
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
