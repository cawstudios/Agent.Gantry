import { randomUUID } from 'node:crypto';

import {
  createSdkMcpServer,
  tool as createSdkTool,
  type McpServerConfig,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { requestCallerResolvedTool } from '../../../../application/interactions/caller-resolved-tool-coordinator.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import type { ProviderInlineAgentLoopLane } from '../../inline-lane-dispatcher.js';
import type { InlineToolActivity } from '../../inline-lane-tool-activity.js';

export const CALLER_MCP_SERVER_NAME = 'caller';

export function createCallerSdkMcpServer(
  input: Parameters<ProviderInlineAgentLoopLane>[0],
  toolActivity: InlineToolActivity,
  nextInteraction: () => number,
): McpServerConfig {
  const config = input.input.callerResolvedTools;
  if (!config) {
    throw new Error('Caller-resolved tool configuration is missing.');
  }
  return createSdkMcpServer({
    name: CALLER_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: config.tools.map((definition) => {
      const schema = z.fromJSONSchema(definition.inputSchema);
      if (!(schema instanceof z.ZodObject)) {
        throw new Error(
          `Caller tool ${definition.name} input_schema must describe an object.`,
        );
      }
      return createSdkTool(
        definition.name,
        definition.description,
        schema.shape,
        async (args) =>
          toolActivity.run(definition.name, async () => {
            if (nextInteraction() > config.maxInteractions) {
              throw new Error(
                `Caller tool interaction limit (${config.maxInteractions}) exceeded.`,
              );
            }
            const interactionId = randomUUID();
            const result = await requestCallerResolvedTool({
              appId: input.input.appId ?? 'default',
              runId: input.input.runId,
              sourceAgentFolder: input.group.folder,
              sessionId: config.sessionId,
              interactionId,
              toolName: definition.name,
              toolInput: args,
              timeoutMs: config.interactionTimeoutMs,
              signal: input.signal,
              emitRequired: () =>
                input.emitOutput({
                  status: 'success',
                  result: null,
                  runtimeEventOnly: true,
                  runtimeEvents: [
                    {
                      sessionId: config.sessionId,
                      eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
                      payload: {
                        interactionId,
                        toolName: definition.name,
                        input: args,
                        expiresInMs: config.interactionTimeoutMs,
                      },
                    },
                  ],
                }),
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result) }],
            } satisfies CallToolResult;
          }),
      ) as SdkMcpToolDefinition<any>;
    }),
    alwaysLoad: true,
  });
}
