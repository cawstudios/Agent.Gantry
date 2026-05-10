import type {
  HookInput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import {
  evaluateProtectedCapabilityToolUse as evaluateCanonicalProtectedCapabilityToolUse,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../shared/tool-execution-policy-service.js';

const BLOCK_MESSAGE =
  'MyClaw blocks direct edits to agent capability configuration. Use request_skill_install, request_skill_proposal, request_skill_dependency_install, request_mcp_server, or request_permission so the change is reviewed, stored durably, and activated through the approved capability flow.';

export interface ProtectedCapabilityDecision {
  reason: string;
  recoveryAction?: string;
}

export function evaluateProtectedCapabilityToolUse(
  toolName: string,
  input: unknown,
): ProtectedCapabilityDecision | null {
  return evaluateCanonicalProtectedCapabilityToolUse(toolName, input);
}

export async function protectedCapabilityPreToolUseHook(
  input: HookInput,
): Promise<SyncHookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') {
    return { continue: true };
  }

  const request = new ToolExecutionClassifier().classify({
    origin: 'sdk',
    toolName: input.tool_name,
    toolInput: input.tool_input,
  });
  const decision = new ToolExecutionPolicyService().evaluate({ request });
  if (decision.status !== 'deny') {
    return { continue: true };
  }

  const reason = `${decision.reason} ${decision.recoveryAction ?? BLOCK_MESSAGE}`;
  return {
    continue: false,
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
