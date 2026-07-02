import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { Scope } from '@core/control/server/auth.js';

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: {
      mcpServers: {},
      tools: {},
      skills: {},
      capabilitySecrets: {},
      agents: {},
    },
  }),
}));

import { McpCapabilitySyncService } from '@core/application/mcp/mcp-capability-sync-service.js';
import { handleMcpServerRoutes } from '@core/control/server/routes/mcp-servers.js';

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

describe('MCP server control routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires mcp:admin for capability sync', async () => {
    const response = await invokeMcpRoute({
      scopes: ['mcp:read'],
      body: {
        agentId: 'agent:main',
        capabilityId: 'itops.access.manage',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.message).toContain('mcp:admin');
  });

  it('rejects capability sync for a different app id', async () => {
    const sync = vi
      .spyOn(McpCapabilitySyncService.prototype, 'sync')
      .mockResolvedValue({
        ok: true,
        dryRun: false,
        capabilityId: 'itops.access.manage',
        serverName: 'itops',
        visibleTools: [],
        approvedToolsBefore: [],
        addedTools: [],
        changed: false,
      });

    const response = await invokeMcpRoute({
      body: {
        appId: 'other',
        agentId: 'agent:main',
        capabilityId: 'itops.access.manage',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(sync).not.toHaveBeenCalled();
  });

  it('uses authenticated control key identity as the capability sync actor', async () => {
    const sync = vi
      .spyOn(McpCapabilitySyncService.prototype, 'sync')
      .mockResolvedValue({
        ok: true,
        dryRun: true,
        capabilityId: 'itops.access.manage',
        serverName: 'itops',
        visibleTools: ['mcp__itops__itops_get_health'],
        approvedToolsBefore: [],
        addedTools: ['mcp__itops__itops_get_health'],
        changed: false,
      });

    const response = await invokeMcpRoute({
      kid: 'ops-key',
      body: {
        agentId: 'main',
        capabilityId: 'itops.access.manage',
        dryRun: true,
        syncedBy: 'spoofed-user',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        agentId: 'main',
        serverId: 'mcp:itops',
        capabilityId: 'itops.access.manage',
        dryRun: true,
        syncedBy: 'ops-key',
      }),
    );
  });
});

async function invokeMcpRoute(input: {
  body: Record<string, unknown>;
  scopes?: Scope[];
  kid?: string;
}): Promise<TestResponse> {
  const path = '/v1/mcp-servers/mcp%3Aitops/sync-capability';
  const req = request('POST', path, input.body, {
    authorization: 'Bearer test-token',
  });
  const res = responseRecorder();
  const ctx = mockContext({
    kid: input.kid ?? 'test-key',
    scopes: input.scopes ?? ['mcp:admin'],
  });
  const url = new URL(path, 'http://localhost');
  const handled = await handleMcpServerRoutes(req, res, ctx, url, url.pathname);
  expect(handled).toBe(true);
  return res;
}

function request(
  method: string,
  _path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): IncomingMessage {
  const rawBody = JSON.stringify(body);
  const stream = Readable.from([rawBody]) as IncomingMessage;
  stream.method = method;
  stream.headers = {
    ...headers,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(rawBody)),
  };
  return stream;
}

function responseRecorder(): TestResponse {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    setHeader(name: string, value: number | string | string[]) {
      this.headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(', ')
        : String(value);
      return this;
    },
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as TestResponse;
}

function mockContext(input: {
  kid: string;
  scopes: Scope[];
}): ControlRouteContext {
  return {
    keys: [
      {
        kid: input.kid,
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(input.scopes),
        appId: 'default',
      },
    ],
    getEgressSettings: () => ({ denylist: [] }),
  } as unknown as ControlRouteContext;
}
