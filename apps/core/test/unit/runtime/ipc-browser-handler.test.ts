import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/runtime/browser-capability.js', () => ({
  DEFAULT_BROWSER_PROFILE_NAME: 'default',
  ensureBrowserReady: vi.fn(async () => ({ ok: true, status: 'launched' })),
  closeBrowser: vi.fn(async () => ({ ok: true, closed: true })),
  getBrowserStatus: vi.fn(() => ({
    profile: 'c-child-abc123abc123',
    profileName: 'c-child-abc123abc123',
    running: true,
    cdpReady: true,
    cdpUrl: 'http://127.0.0.1:9222',
    port: 9222,
    pid: 123,
    targetId: 'target-1',
  })),
}));

vi.mock('@core/runtime/browser-profiles.js', () => ({
  createProfile: vi.fn(() => ({
    name: 'default',
    statePath: '/tmp/browser-state',
    metadata: {
      created_at: '2024-01-01T00:00:00.000Z',
      last_used: '2024-01-01T00:00:00.000Z',
      cdp_port: 9222,
      auth_markers: [],
    },
  })),
  isValidBrowserProfileName: vi.fn((name: string) =>
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name),
  ),
}));

vi.mock('@core/runtime/browser-cdp-targets.js', () => ({
  ensureBrowserTarget: vi.fn(async () => 'target-1'),
}));

import { BrowserIpcAction } from '@myclaw/contracts';

import {
  createIpcResponseSigningKeyPair,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from '@core/runtime/ipc-browser-handler.js';
import {
  ensureBrowserReady,
  getBrowserStatus,
} from '@core/runtime/browser-capability.js';
function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe('ipc-browser-handler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-browser-handler-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('allows conversation-scoped groups to inspect browser status', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1',
        action: 'browser_status',
        payload: {},
      },
      {
        sourceAgentFolder: 'child',
        browserProfileName: 'c-child-abc123abc123',
      },
    );

    expect(response.ok).toBe(true);
    expect(getBrowserStatus).toHaveBeenCalledWith('c-child-abc123abc123');
    expect(response.data).toMatchObject({
      profileName: 'c-child-abc123abc123',
      running: true,
      cdpReady: true,
    });
    expect(response.data).not.toHaveProperty('cdpUrl');
    expect(response.data).not.toHaveProperty('port');
    expect(response.data).not.toHaveProperty('pid');
    expect(response.data).not.toHaveProperty('targetId');
  });

  it('ignores conversation-scoped profile overrides and uses the host-derived profile', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1a',
        action: 'browser_status',
        payload: {
          profile_name: 'c-child-other123456',
        },
      },
      {
        sourceAgentFolder: 'child',
        browserProfileName: 'c-child-abc123abc123',
      },
    );

    expect(response.ok).toBe(true);
    expect(getBrowserStatus).toHaveBeenCalledWith('c-child-abc123abc123');
  });

  it('prevents agents from switching to another browser profile', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1b',
        action: 'browser_status',
        payload: { profile_name: 'default' },
      },
      {
        sourceAgentFolder: 'child',
        browserProfileName: 'c-child-abc123abc123',
      },
    );

    expect(response.ok).toBe(true);
    expect(getBrowserStatus).toHaveBeenCalledWith('c-child-abc123abc123');
  });

  it('ignores forged top-level browser profile scope from child IPC', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1d',
        action: 'browser_status',
        payload: {
          profile_name: 'c-child-other123456',
        },
        browserProfileName: 'c-child-other123456',
      } as never,
      {
        sourceAgentFolder: 'child',
        browserProfileName: 'c-child-abc123abc123',
      },
    );

    expect(response.ok).toBe(true);
    expect(getBrowserStatus).toHaveBeenCalledWith('c-child-abc123abc123');
  });

  it('dispatches browser tools through the private backend after lazy launch', async () => {
    const callBrowserTool = vi.fn(async () => ({ content: 'tool-result' }));
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1c',
        action: 'browser_navigate',
        payload: { url: 'https://example.test' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserReady).toHaveBeenCalledWith({
      profileName: 'c-main-abc123abc123',
    });
    expect(callBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        fileAccessRoot: expect.stringContaining('/sessions/main/extra'),
        toolName: 'browser_navigate',
        arguments: { url: 'https://example.test' },
      }),
    );
    expect(response.data).toEqual({ content: 'tool-result' });
  });

  it('denies non-status browser IPC when Browser is not authorized for the run', async () => {
    const callBrowserTool = vi.fn();
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-1e',
        action: 'browser_navigate',
        payload: { url: 'https://example.test' },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        callBrowserTool,
      },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Browser IPC is not authorized');
    expect(ensureBrowserReady).not.toHaveBeenCalled();
    expect(callBrowserTool).not.toHaveBeenCalled();
  });

  it('dispatches browser actions via explicit handlers', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-2',
        action: 'browser_launch',
        payload: {
          profile_name: 'default',
          headless: true,
        },
      },
      { sourceAgentFolder: 'main', browserIpcAuthorized: true },
    );

    expect(response.ok).toBe(true);
    expect(response.data).not.toHaveProperty('cdpUrl');
    expect(response.data).not.toHaveProperty('port');
    expect(response.data).not.toHaveProperty('pid');
    expect(response.data).not.toHaveProperty('targetId');
    expect(ensureBrowserReady).toHaveBeenCalledTimes(1);
    expect(ensureBrowserReady).toHaveBeenCalledWith({
      profileName: 'default',
      headless: true,
      keepAliveMs: undefined,
    });
  });

  it('includes tool-capability broker health on browser launch', async () => {
    const healthCheck = vi.fn(async () => ({
      status: 'fail' as const,
      message:
        'Could not reach OneCLI at http://localhost:10254: connect ECONNREFUSED',
      nextAction:
        "Run `myclaw local doctor`. If you use MyClaw's provided local stack, start it from the directory containing the shipped stack file, or pass that stack file explicitly, then retry.",
    }));

    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-2b',
        action: 'browser_launch',
        payload: {},
      },
      {
        sourceAgentFolder: 'main_agent',
        browserIpcAuthorized: true,
        getCredentialBrokerProfile: () => 'onecli',
        getCredentialBroker: async () => ({
          getInjection: vi.fn(),
          healthCheck,
          getCapabilities: () => ({
            profile: 'onecli',
            supportsAgentBinding: true,
            returnsRawSecrets: false,
          }),
        }),
      },
    );

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      brokerHealthy: false,
      brokerHealth: {
        status: 'fail',
        message:
          'Could not reach OneCLI at http://localhost:10254: connect ECONNREFUSED',
      },
      warning: expect.stringContaining('third-party MCP tools can fail'),
    });
    expect(healthCheck).toHaveBeenCalledWith({
      binding: {
        profile: 'onecli',
        purpose: 'tool_capability',
        agentIdentifier: 'agent:main_agent',
      },
    });
  });

  it('keeps browser status available when broker health check throws', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-2c',
        action: 'browser_status',
        payload: {},
      },
      {
        sourceAgentFolder: 'main_agent',
        getCredentialBrokerProfile: () => 'onecli',
        getCredentialBroker: async () => ({
          getInjection: vi.fn(),
          healthCheck: vi.fn(async () => {
            throw new Error('broker temporarily unavailable');
          }),
          getCapabilities: () => ({
            profile: 'onecli',
            supportsAgentBinding: true,
            returnsRawSecrets: false,
          }),
        }),
      },
    );

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      running: true,
      cdpReady: true,
      brokerHealthy: false,
      brokerHealth: {
        status: 'fail',
        message: 'Credential broker health check failed.',
      },
      warning: expect.stringContaining('third-party MCP tools can fail'),
    });
  });

  it('caches healthy broker status for repeated browser status calls', async () => {
    const healthCheck = vi.fn(async () => ({
      status: 'pass' as const,
      message: 'ok',
    }));
    const context = {
      sourceAgentFolder: 'cache_agent',
      getCredentialBrokerProfile: () => 'onecli',
      getCredentialBroker: async () => ({
        getInjection: vi.fn(),
        healthCheck,
        getCapabilities: () => ({
          profile: 'onecli',
          supportsAgentBinding: true,
          returnsRawSecrets: false,
        }),
      }),
    };

    for (const requestId of ['req-cache-1', 'req-cache-2']) {
      const response = await processBrowserIpcRequest(
        {
          requestId,
          action: 'browser_status',
          payload: {},
        },
        context,
      );
      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({ brokerHealthy: true });
    }
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it('ignores main-agent profile overrides and uses host-derived profile', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-2a',
        action: 'browser_launch',
        payload: {
          profile_name: 'other-profile',
          headless: true,
        },
      },
      {
        sourceAgentFolder: 'main',
        browserProfileName: 'c-main-abc123abc123',
        browserIpcAuthorized: true,
      },
    );

    expect(response.ok).toBe(true);
    expect(ensureBrowserReady).toHaveBeenCalledWith(
      expect.objectContaining({ profileName: 'c-main-abc123abc123' }),
    );
  });

  it('returns unsupported error for unknown browser action', async () => {
    const response = await processBrowserIpcRequest(
      {
        requestId: 'req-3',
        action: 'browser_not_real' as BrowserIpcAction,
        payload: {},
      },
      { sourceAgentFolder: 'main' },
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Unsupported browser IPC action');
  });

  it('writes browser response files atomically', () => {
    const keys = createIpcResponseSigningKeyPair();
    writeBrowserIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'req-4',
        ok: true,
        data: { running: true },
      },
      keys.privateKeyPem,
    );

    const responsePath = path.join(
      tempDir,
      'grp',
      'browser-responses',
      'req-4.json',
    );
    const payload = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    expect(payload).toMatchObject({
      requestId: 'req-4',
      ok: true,
      data: { running: true },
    });
    expect(fileMode(path.dirname(responsePath))).toBe(0o700);
    expect(fileMode(responsePath)).toBe(0o600);
    expect(getBrowserStatus).not.toHaveBeenCalled();
  });

  it('signs browser responses with the MCP client verification shape', () => {
    const keys = createIpcResponseSigningKeyPair();

    writeBrowserIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'req-5',
        ok: true,
        data: { running: true },
      },
      keys.privateKeyPem,
    );

    const responsePath = path.join(
      tempDir,
      'grp',
      'browser-responses',
      'req-5.json',
    );
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
    const runnerVerificationPayload = {
      ok: true,
      requestId: 'req-5',
      data: { running: true },
    };

    expect(
      verifyIpcResponsePayload(
        keys.publicKeyPem,
        runnerVerificationPayload,
        response.signature,
      ),
    ).toBe(true);
  });

  it('does not write browser responses without a run response signing key', () => {
    writeBrowserIpcResponse(tempDir, 'grp', {
      requestId: 'req-5',
      ok: true,
      data: { running: true },
    });

    const responsePath = path.join(
      tempDir,
      'grp',
      'browser-responses',
      'req-5.json',
    );
    expect(fs.existsSync(responsePath)).toBe(false);
  });
});
