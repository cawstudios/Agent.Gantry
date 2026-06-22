import {
  DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
  evaluateDeepAgentsAsyncSubagentSentinel,
} from './async-subagent-sentinel.js';

export interface AgentDelegationAsyncIntent {
  toolName: 'AgentDelegation';
  task: string;
}

export interface AgentDelegationAsyncBridgeInput {
  intent: AgentDelegationAsyncIntent;
  packageVersion: string;
  providerModule: Record<string, unknown>;
  asyncTaskToolsEnabled: boolean;
  sandboxReady: boolean;
  agentDelegationAuthorized: boolean;
  transportReady: boolean;
}

export type AgentDelegationAsyncBridgeUnavailableReason =
  | 'async_task_tools_disabled'
  | 'sandbox_unavailable'
  | 'agent_delegation_unauthorized'
  | 'transport_unavailable'
  | 'provider_async_bridge_unavailable';

export type AgentDelegationAsyncBridgeResult =
  | {
      status: 'ready';
      intent: AgentDelegationAsyncIntent;
      packageVersion: string;
      apiCompatible: true;
    }
  | {
      status: 'unavailable';
      reason: AgentDelegationAsyncBridgeUnavailableReason;
      message: typeof DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE;
    };

export function evaluateAgentDelegationAsyncBridge(
  input: AgentDelegationAsyncBridgeInput,
): AgentDelegationAsyncBridgeResult {
  if (!input.asyncTaskToolsEnabled) {
    return unavailable('async_task_tools_disabled');
  }
  if (!input.sandboxReady) {
    return unavailable('sandbox_unavailable');
  }
  if (!input.agentDelegationAuthorized) {
    return unavailable('agent_delegation_unauthorized');
  }
  if (!input.transportReady) {
    return unavailable('transport_unavailable');
  }

  const sentinel = evaluateDeepAgentsAsyncSubagentSentinel({
    packageVersion: input.packageVersion,
    deepagentsModule: input.providerModule,
    gantryAgentProtocolTransportReady: true,
  });

  if (!sentinel.ok) {
    return unavailable('provider_async_bridge_unavailable');
  }

  return {
    status: 'ready',
    intent: input.intent,
    packageVersion: sentinel.packageVersion,
    apiCompatible: true,
  };
}

function unavailable(
  reason: AgentDelegationAsyncBridgeUnavailableReason,
): AgentDelegationAsyncBridgeResult {
  return {
    status: 'unavailable',
    reason,
    message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
  };
}
