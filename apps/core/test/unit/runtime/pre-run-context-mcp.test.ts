import { describe, expect, it, vi } from 'vitest';

import { createPreRunMcpCaller } from '@core/runtime/pre-run-context-mcp.js';

describe('createPreRunMcpCaller', () => {
  it('calls the existing MCP proxy with verified conversation identity', async () => {
    const proxy = { callTool: vi.fn(async () => ({ content: [] })) };
    const call = createPreRunMcpCaller({ makeProxy: () => proxy as never });

    await call({
      appId: 'default',
      agentId: 'agent:boondi_support',
      conversationJid: 'wa:000299180577',
      serverName: 'boondi-crm',
      toolName: 'get_last_query_or_lead',
      arguments: {},
    });

    expect(proxy.callTool).toHaveBeenCalledWith({
      appId: 'default',
      agentId: 'agent:boondi_support',
      serverName: 'boondi-crm',
      toolName: 'get_last_query_or_lead',
      arguments: {},
    });
  });
});
