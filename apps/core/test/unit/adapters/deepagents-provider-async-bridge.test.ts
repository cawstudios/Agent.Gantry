import { describe, expect, it, vi } from 'vitest';

import { evaluateAgentDelegationAsyncBridge } from '@core/adapters/llm/deepagents-langchain/runner/agent-delegation-async-bridge.js';
import {
  DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
  EXPECTED_DEEPAGENTS_ASYNC_TOOL_NAMES,
  EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS,
  SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
} from '@core/adapters/llm/deepagents-langchain/runner/async-subagent-sentinel.js';

function fakeBridgeProviderModule() {
  return {
    isAsyncSubAgent: vi.fn((subagent: unknown) =>
      Boolean(
        subagent && typeof subagent === 'object' && 'graphId' in subagent,
      ),
    ),
    createAsyncSubAgentMiddleware: vi.fn(() => ({
      name: 'asyncSubAgentMiddleware',
      tools: EXPECTED_DEEPAGENTS_ASYNC_TOOL_NAMES.map((name) => ({
        name,
        schema: {
          shape: Object.fromEntries(
            EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS[
              name as keyof typeof EXPECTED_DEEPAGENTS_ASYNC_TOOL_SCHEMAS
            ].map((key) => [key, {}]),
          ),
        },
      })),
    })),
  };
}

describe('DeepAgents provider async bridge gate', () => {
  it('denies before raw DeepAgents async middleware can spawn work', () => {
    const withoutDelegationProvider = fakeBridgeProviderModule();
    const withoutDelegation = evaluateAgentDelegationAsyncBridge({
      intent: { toolName: 'AgentDelegation', task: 'research accounts' },
      packageVersion: SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
      providerModule: withoutDelegationProvider,
      asyncTaskToolsEnabled: true,
      sandboxReady: true,
      agentDelegationAuthorized: false,
      transportReady: true,
    });

    expect(withoutDelegation).toEqual({
      status: 'unavailable',
      reason: 'agent_delegation_unauthorized',
      message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
    });
    expect(
      withoutDelegationProvider.createAsyncSubAgentMiddleware,
    ).not.toHaveBeenCalled();

    const withoutTransportProvider = fakeBridgeProviderModule();
    const withoutTransport = evaluateAgentDelegationAsyncBridge({
      intent: { toolName: 'AgentDelegation', task: 'research accounts' },
      packageVersion: SUPPORTED_DEEPAGENTS_ASYNC_SUBAGENT_VERSION,
      providerModule: withoutTransportProvider,
      asyncTaskToolsEnabled: true,
      sandboxReady: true,
      agentDelegationAuthorized: true,
      transportReady: false,
    });

    expect(withoutTransport).toEqual({
      status: 'unavailable',
      reason: 'transport_unavailable',
      message: DEEPAGENTS_ASYNC_DELEGATION_UNAVAILABLE_MESSAGE,
    });
    expect(
      withoutTransportProvider.createAsyncSubAgentMiddleware,
    ).not.toHaveBeenCalled();
  });
});
