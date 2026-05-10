import type { GroupProcessingDeps } from './group-processing-types.js';
import { resolveConfiguredAllowedTools } from './configured-agent-tools.js';

export function memoryScopeForConversationKind(
  conversationKind?: string,
): 'user' | 'group' {
  return conversationKind === 'dm' ? 'user' : 'group';
}

export async function resolveTurnAllowedTools(
  deps: Pick<GroupProcessingDeps, 'getToolRepository'>,
  turnContext?: { appId: string; agentId: string } | null,
) {
  if (!turnContext) return undefined;
  return resolveConfiguredAllowedTools({
    repository: deps.getToolRepository?.(),
    appId: turnContext.appId,
    agentId: turnContext.agentId,
  });
}

export async function resolveTurnSelectedSkillIds(
  deps: Pick<GroupProcessingDeps, 'getSkillRepository'>,
  turnContext?: { appId: string; agentId: string } | null,
): Promise<string[] | undefined> {
  const repository = deps.getSkillRepository?.();
  if (!turnContext || !repository) return undefined;
  const bindings = await repository.listAgentSkillBindings({
    appId: turnContext.appId as never,
    agentId: turnContext.agentId as never,
  });
  return bindings
    .filter((binding) => binding.status === 'active')
    .map((binding) => String(binding.skillId));
}

export async function resolveTurnSelectedMcpServerIds(
  deps: Pick<GroupProcessingDeps, 'getMcpServerRepository'>,
  turnContext?: { appId: string; agentId: string } | null,
): Promise<string[] | undefined> {
  const repository = deps.getMcpServerRepository?.();
  if (!turnContext || !repository) return undefined;
  const bindings = await repository.listAgentBindings({
    appId: turnContext.appId as never,
    agentId: turnContext.agentId as never,
    limit: 500,
  });
  return bindings
    .filter((binding) => binding.status === 'active')
    .map((binding) => String(binding.serverId));
}
