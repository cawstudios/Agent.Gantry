import type { Job } from '../../domain/types.js';
import type { ToolCatalogRepository } from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';
import { isMyClawMcpWildcardRule } from '../../shared/admin-mcp-tools.js';
import {
  BROWSER_ACTION_MCP_RULE_REJECTION_REASON,
  BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
  isBrowserActionMcpToolRule,
  isProjectedBrowserMcpToolRule,
} from '../../shared/agent-tool-references.js';

export interface JobToolPolicyResolution {
  inheritedTools: string[];
  effectiveAllowedTools: string[];
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
}): Promise<JobToolPolicyResolution> {
  const inheritedTools =
    input.appId && input.agentId
      ? await resolveAgentToolBindings({
          repository: input.toolRepository,
          appId: input.appId,
          agentId: input.agentId,
        })
      : [];
  return {
    inheritedTools,
    effectiveAllowedTools: mergeUnique(inheritedTools),
  };
}

export async function resolveAgentToolBindings(input: {
  repository?: ToolCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<string[]> {
  if (!input.repository) return [];
  const bindings = await input.repository.listAgentToolBindings({
    appId: input.appId as never,
    agentId: input.agentId as never,
  });
  const activeBindings = bindings.filter(
    (binding) => binding.status === 'active',
  );
  const tools = await Promise.all(
    activeBindings.map((binding) => input.repository?.getTool(binding.toolId)),
  );
  const rules = tools.flatMap((tool) => {
    if (tool?.appId && tool.appId !== input.appId) return [];
    const name = tool?.name?.trim();
    return name ? [name] : [];
  });
  const staleBrowserRule = rules.find(isBrowserActionMcpToolRule);
  if (staleBrowserRule) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Inherited agent tool ${staleBrowserRule} is invalid. ${BROWSER_ACTION_MCP_RULE_REJECTION_REASON}`,
    );
  }
  const projectedBrowserRule = rules.find(isProjectedBrowserMcpToolRule);
  if (projectedBrowserRule) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Inherited agent tool ${projectedBrowserRule} is invalid. ${BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON}`,
    );
  }
  const myclawWildcardRule = rules.find(isMyClawMcpWildcardRule);
  if (myclawWildcardRule) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Inherited agent tool ${myclawWildcardRule} is invalid. Persistent MyClaw MCP wildcard grants are not supported; request one exact mcp__myclaw__ tool.`,
    );
  }
  return rules;
}

function mergeUnique(base: readonly string[]): string[] {
  const out = new Set<string>();
  for (const item of base) {
    const value = item.trim();
    if (value) out.add(value);
  }
  return [...out];
}
