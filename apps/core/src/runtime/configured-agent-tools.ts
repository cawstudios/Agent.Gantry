import type { ToolCatalogRepository } from '../domain/ports/repositories.js';
import {
  BROWSER_ACTION_MCP_RULE_REJECTION_REASON,
  BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
  isBrowserActionMcpToolRule,
  isProjectedBrowserMcpToolRule,
} from '../shared/agent-tool-references.js';
import { isMyClawMcpWildcardRule } from '../shared/admin-mcp-tools.js';

export async function resolveConfiguredAllowedTools(input: {
  repository?: ToolCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<string[] | undefined> {
  if (!input.repository) return undefined;
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
    throw new Error(
      `Configured agent tool ${staleBrowserRule} is invalid. ${BROWSER_ACTION_MCP_RULE_REJECTION_REASON}`,
    );
  }
  const projectedBrowserRule = rules.find(isProjectedBrowserMcpToolRule);
  if (projectedBrowserRule) {
    throw new Error(
      `Configured agent tool ${projectedBrowserRule} is invalid. ${BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON}`,
    );
  }
  const myclawWildcardRule = rules.find(isMyClawMcpWildcardRule);
  if (myclawWildcardRule) {
    throw new Error(
      `Configured agent tool ${myclawWildcardRule} is invalid. Persistent MyClaw MCP wildcard grants are not supported; request one exact mcp__myclaw__ tool.`,
    );
  }
  return rules;
}
