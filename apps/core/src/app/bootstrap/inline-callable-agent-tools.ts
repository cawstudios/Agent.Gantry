import { projectCallableAgentTools } from '../../application/core-tools/callable-agent-tools.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentRepository } from '../../domain/ports/repositories.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';

export type InlineConfiguredAgents = Record<
  string,
  | { capabilities?: Array<{ id: string }>; delegates?: string[] }
  | null
  | undefined
>;

export async function resolveInlineCallableAgentManifest(
  laneInput: InlineAgentLoopLaneInput,
  repository: AgentRepository | undefined,
  configuredAgents?: InlineConfiguredAgents,
  toolsAvailable = true,
) {
  const run = laneInput.input;
  const delegates = configuredAgents?.[laneInput.group.folder]?.delegates ?? [];
  if (
    !toolsAvailable ||
    run.disableTools === true ||
    run.hideAuthorityTools === true ||
    !repository ||
    !run.appId ||
    !run.agentId ||
    run.parentTaskId != null ||
    !run.toolPolicyRules?.includes('AgentDelegation') ||
    delegates.length === 0
  ) {
    return [];
  }
  return projectCallableAgentTools({
    agents: await repository.listAgents(run.appId as AppId),
    callerAppId: run.appId,
    callerAgentId: run.agentId,
    callerFolder: laneInput.group.folder,
    delegates,
    toolPolicyRules: run.toolPolicyRules,
    parentTaskId: run.parentTaskId,
  });
}
