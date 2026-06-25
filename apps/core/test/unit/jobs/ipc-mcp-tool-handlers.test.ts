import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';
import { createMcpToolHandlers } from '@core/jobs/ipc-mcp-tool-handlers.js';

const runtimeHomes: string[] = [];

afterEach(() => {
  configurePendingInteractionDurability(null);
  vi.unstubAllEnvs();
  while (runtimeHomes.length > 0) {
    const runtimeHome = runtimeHomes.pop();
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

async function loadMcpHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const applicationError =
    await import('@core/application/common/application-error.js');
  const pendingInteractionDurability =
    await import('@core/application/interactions/pending-interaction-durability.js');
  const handlers = await import('@core/jobs/ipc-mcp-tool-handlers.js');
  return {
    ...handlers,
    ApplicationError: applicationError.ApplicationError,
    configurePendingInteractionDurability:
      pendingInteractionDurability.configurePendingInteractionDurability,
    taskData: (
      taskId: string,
      payload: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => {
      const envelope = ipcAuth.createIpcAuthEnvelope('main_agent', 'thread-1');
      return {
        type: 'mcp_call_tool',
        taskId,
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        authThreadId: 'thread-1',
        responseKeyId: envelope.responseKeyId,
        payload,
        ...extra,
      };
    },
  };
}

function createRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-mcp-ipc-'));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

function readResponse(runtimeHome: string, taskId: string) {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        runtimeHome,
        'data',
        'ipc',
        'main_agent',
        'task-responses',
        `task-${taskId}.json`,
      ),
      'utf-8',
    ),
  );
}

describe('MCP IPC tool handlers', () => {
  it('uses the signed runner agent id for MCP tool calls', async () => {
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { mcpCallToolHandler } = createMcpToolHandlers(createProxy as never);

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(createProxy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:signed' }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:signed' }),
    );
  });

  it('rejects side-effecting MCP calls when the run lease is stale', async () => {
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'new-lease',
          fencingVersion: 8,
        })),
      } as never,
    });
    const { mcpCallToolHandler } = createMcpToolHandlers(createProxy as never);

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        appId: 'app:test',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runLeaseToken: 'old-lease',
        runLeaseFencingVersion: 7,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(callTool).not.toHaveBeenCalled();
  });

  it('returns missing MCP capability binding denials as recoverable tool data', async () => {
    const runtimeHome = createRuntimeHome();
    const {
      ApplicationError,
      configurePendingInteractionDurability,
      createMcpToolHandlers,
      taskData,
    } = await loadMcpHandlers(runtimeHome);
    const callTool = vi.fn(async () => {
      throw new ApplicationError(
        'FORBIDDEN',
        'MCP tool is not approved for this agent: mcp__itops__itops_resolve_employee',
      );
    });
    const createProxy = vi.fn(async () => ({
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });
    const { mcpCallToolHandler } = createMcpToolHandlers(createProxy as never);

    await mcpCallToolHandler({
      data: taskData(
        'mcp-missing-binding',
        {
          serverName: 'itops',
          toolName: 'itops_resolve_employee',
          arguments: { name: 'Ameer' },
        },
        {
          runId: 'run-1',
          runLeaseToken: 'lease-1',
          runLeaseFencingVersion: 1,
        },
      ),
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const response = readResponse(runtimeHome, 'mcp-missing-binding');
    expect(response).toMatchObject({
      ok: true,
      code: 'missing_capability_binding',
      data: {
        errorType: 'missing_capability_binding',
        tool: 'mcp__itops__itops_resolve_employee',
      },
    });
    expect(response.data.message).toContain(
      'connected but not approved by the selected capability',
    );
  });
});
