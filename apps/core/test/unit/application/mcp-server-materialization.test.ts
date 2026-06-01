import { describe, expect, it } from 'vitest';

import { materializeMcpRecord } from '@core/application/mcp/mcp-server-materialization.js';

function recordWithTemplate(templateId: string | undefined) {
  return {
    definition: {
      name: 'github',
      config: { transport: 'stdio_template', templateId },
      credentialRefs: [],
      allowedToolPatterns: ['search'],
      autoApproveToolPatterns: [],
    },
    binding: { required: false },
  } as never;
}

function recordWithRemoteTransport(
  transport: 'http' | 'sse',
  options: {
    url?: string;
    headers?: Record<string, string>;
    credentialRefs?: Array<{ name: string; target: 'header'; key: string }>;
  } = {},
) {
  return {
    definition: {
      name: 'github',
      config: {
        transport,
        url: options.url ?? 'https://mcp.example.test/github',
        ...(options.headers ? { headers: options.headers } : {}),
      },
      credentialRefs: options.credentialRefs ?? [],
      allowedToolPatterns: ['search'],
      autoApproveToolPatterns: [],
    },
    binding: { required: false },
  } as never;
}

describe('materializeMcpRecord', () => {
  it('throws a typed error for unsupported persisted stdio templates', () => {
    expect(() =>
      materializeMcpRecord(recordWithTemplate('removed-template'), {}),
    ).toThrow(/unsupported templateId/);
    try {
      materializeMcpRecord(recordWithTemplate(undefined), {});
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });

  it('fails closed instead of projecting remote MCP servers directly to the SDK', () => {
    for (const transport of ['http', 'sse'] as const) {
      expect(() =>
        materializeMcpRecord(recordWithRemoteTransport(transport), {}),
      ).toThrow(/DNS-pinned host transport/);
    }
  });

  it('can materialize remote MCP servers for the Gantry proxy', () => {
    expect(
      materializeMcpRecord(
        recordWithRemoteTransport('http', {
          url: 'http://127.0.0.1:3030/mcp',
          headers: { 'x-static': 'safe' },
          credentialRefs: [
            {
              name: 'MCP_TOKEN',
              target: 'header',
              key: 'Authorization',
            },
          ],
        }),
        { MCP_TOKEN: 'Bearer secret' },
        { allowRemoteHttpProjection: true },
      ),
    ).toMatchObject({
      name: 'github',
      config: {
        type: 'http',
        url: 'http://127.0.0.1:3030/mcp',
        headers: {
          'x-static': 'safe',
          Authorization: 'Bearer secret',
        },
      },
      allowedToolNames: ['mcp__github__search'],
    });
  });
});
