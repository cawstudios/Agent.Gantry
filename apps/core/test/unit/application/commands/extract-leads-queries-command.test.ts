import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isAgentCommandModule } from '@core/application/commands/agent-command-types.js';
// Self-contained agent module, imported by relative path the same way
// customer-support-guardrails.test.ts imports the agent guardrail — it lives
// under agents/, outside core's src, and must not depend on core.
import { command } from '../../../../../../agents/boondi_support/commands/extract-leads-queries.ts';
import { verifyIdentityHeader } from '../../../../../../packages/mcp-crm/src/identity/identity-header.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

const ctx = (conversationId: string) => ({
  conversationId,
  conversationJid: conversationId.replace(/^conversation:/, ''),
  threadId: null,
});

describe('boondi extract-leads-queries command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T12:00:00.000Z'));
    process.env = { ...originalEnv };
    delete process.env.BOONDI_CRM_MCP_URL;
    delete process.env.BOONDI_CRM_MCP_PORT;
    delete process.env.MCP_IDENTITY_SECRET;
    process.env.GANTRY_HOME = fs.mkdtempSync(
      path.join(os.tmpdir(), 'cmd-env-'),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('is a valid AgentCommandModule that core can load', () => {
    expect(isAgentCommandModule(command)).toBe(true);
    expect(command.name).toBe('extract-leads-queries');
    expect(command.visibility).toBe('operator');
    expect(command.ackOnStart).toBeTruthy();
  });

  it('posts the conversation id to the configured admin endpoint and relays stats', async () => {
    process.env.BOONDI_CRM_MCP_URL = 'http://crm.local:8099/ignored?x=1';
    const fetchMock = vi.fn(async () =>
      Response.json({
        stats: { extracted: 2, created: 1, updated: 1, skipped: 0 },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await command.run(ctx('conversation:wa:919876543210'));

    expect(result).toBe(
      'Lead/query extraction processed. Extracted: 2. Created: 1. Updated: 1. Skipped: 0.',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://crm.local:8099/admin/extract-leads-queries',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          conversationId: 'conversation:wa:919876543210',
        }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('signs caller identity when an MCP identity secret is available', async () => {
    process.env.BOONDI_CRM_MCP_PORT = '8085';
    process.env.MCP_IDENTITY_SECRET = 'test-secret';
    const fetchMock = vi.fn(async () => Response.json({ stats: {} }));
    globalThis.fetch = fetchMock as typeof fetch;

    await command.run(ctx('conversation:wa:919876543210'));

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Caller-Identity']).toMatch(
      /^phone:919876543210;ts:1781006400;sig:[a-f0-9]{64}$/,
    );
    expect(
      verifyIdentityHeader(headers['X-Caller-Identity'], {
        secret: 'test-secret',
        maxAgeSec: 120,
      }),
    ).toMatchObject({ kind: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8085/admin/extract-leads-queries',
      expect.any(Object),
    );
  });

  it('rejects non-WhatsApp conversation ids before calling the CRM endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ stats: {} }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(command.run(ctx('conversation:sl:C123'))).rejects.toThrow(
      /conversation:wa:<digits>/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a sanitized error when the CRM endpoint fails', async () => {
    process.env.BOONDI_CRM_MCP_PORT = '8085';
    const fetchMock = vi.fn(async () => new Response('boom', { status: 502 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      command.run(ctx('conversation:wa:919876543210')),
    ).rejects.toThrow(/extraction request failed \(502\): boom/);
  });

  it('omits the identity header when no secret is configured anywhere', async () => {
    const fetchMock = vi.fn(async () => Response.json({ stats: {} }));
    globalThis.fetch = fetchMock as typeof fetch;

    await command.run(ctx('conversation:wa:919876543210'));

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Caller-Identity']).toBeUndefined();
  });

  it('falls back to the GANTRY_HOME runtime env file for secret, url, and port', async () => {
    fs.writeFileSync(
      path.join(process.env.GANTRY_HOME as string, '.env'),
      [
        'MCP_IDENTITY_SECRET="file-secret"',
        'BOONDI_CRM_MCP_PORT=9099',
        '',
      ].join('\n'),
      'utf8',
    );
    const fetchMock = vi.fn(async () => Response.json({ stats: {} }));
    globalThis.fetch = fetchMock as typeof fetch;

    await command.run(ctx('conversation:wa:919876543210'));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9099/admin/extract-leads-queries',
      expect.any(Object),
    );
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(
      verifyIdentityHeader(headers['X-Caller-Identity'], {
        secret: 'file-secret',
        maxAgeSec: 120,
      }),
    ).toMatchObject({ kind: 'ok' });
  });

  it('declares a timeout above the CRM extraction budget and zero-fills malformed stats', async () => {
    expect(command.timeoutMs).toBe(150_000);
    const fetchMock = vi.fn(async () =>
      Response.json({ stats: { extracted: 'x', created: 2 } }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await command.run(ctx('conversation:wa:919876543210'));
    expect(result).toBe(
      'Lead/query extraction processed. Extracted: 0. Created: 2. Updated: 0. Skipped: 0.',
    );
  });
});
