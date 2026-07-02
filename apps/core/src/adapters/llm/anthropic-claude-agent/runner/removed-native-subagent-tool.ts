import type { AgentRunnerInput } from './types.js';
import { emitJobToolActivity } from './tool-permission-events.js';
import { log } from './logging.js';

const REMOVED_NATIVE_SUBAGENT_TOOL =
  /^Task(Create|Get|List|Output|Stop|Update)?$/;

export function denyRemovedNativeSubagentTool(input: {
  toolName: string;
  agentInput: AgentRunnerInput;
  getNewSessionId: () => string | undefined;
}): { behavior: 'deny'; message: string; interrupt: false } | undefined {
  if (!REMOVED_NATIVE_SUBAGENT_TOOL.test(input.toolName)) return undefined;
  const message =
    'Native SDK Task subagent tools are not supported. Use the Agent tool for native subagents, or request the Gantry AgentDelegation facade.';
  log(`Permission denied by native subagent tool cut: ${message}`);
  emitJobToolActivity(
    input.agentInput,
    input.getNewSessionId,
    'deny',
    input.toolName,
    { ok: false, reason: message, decision: 'removed_native_subagent_tool' },
  );
  return { behavior: 'deny', message, interrupt: false };
}
