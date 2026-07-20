import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.GANTRY_IPC_DIR ??= '/tmp';
  process.env.GANTRY_CHAT_JID ??= 'app:test';
  process.env.GANTRY_WORKSPACE_KEY ??= 'workspace';
});

import { registerCallerResolvedTools } from '@core/runner/mcp/tools/caller-resolved.js';

class TestMcpServer {
  readonly tools = new Map<
    string,
    { options: { description: string; inputSchema: unknown }; handler: unknown }
  >();

  registerTool(
    name: string,
    options: { description: string; inputSchema: unknown },
    handler: unknown,
  ) {
    this.tools.set(name, { options, handler });
  }
}

const originalConfig = process.env.GANTRY_CALLER_RESOLVED_TOOLS_JSON;

describe('caller-resolved MCP tools', () => {
  afterEach(() => {
    if (originalConfig === undefined) {
      delete process.env.GANTRY_CALLER_RESOLVED_TOOLS_JSON;
    } else {
      process.env.GANTRY_CALLER_RESOLVED_TOOLS_JSON = originalConfig;
    }
  });

  it('registers JSON Schema caller tools as an MCP Zod raw shape', () => {
    process.env.GANTRY_CALLER_RESOLVED_TOOLS_JSON = JSON.stringify({
      interactionTimeoutMs: 90_000,
      tools: [
        {
          name: 'search_tender_evidence',
          description: 'Search tender evidence.',
          inputSchema: {
            type: 'object',
            properties: {
              queryId: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['queryId', 'text'],
            additionalProperties: false,
          },
        },
      ],
    });

    const server = new TestMcpServer();
    registerCallerResolvedTools(server as never);

    const schema = server.tools.get('search_tender_evidence')?.options
      .inputSchema as {
      queryId?: unknown;
      text?: unknown;
      safeParse?: unknown;
    };

    expect(schema.queryId).toBeTruthy();
    expect(schema.text).toBeTruthy();
    expect(schema.safeParse).toBeUndefined();
  });
});
