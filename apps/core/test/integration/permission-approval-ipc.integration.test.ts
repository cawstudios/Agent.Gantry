import { afterEach, describe, expect, it, vi } from 'vitest';

describe('permission approval socket IPC boundary', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const { clearConsumedIpcRequestIds } =
      await import('@core/runtime/ipc-auth-validation.js');
    clearConsumedIpcRequestIds();
  });

  it('sends a signed permission request over the active runner socket and accepts a signed approval', async () => {
    vi.stubEnv('GANTRY_IPC_AUTH_SECRET', 'perm-ipc-secret');
    vi.stubEnv('GANTRY_WORKSPACE_GROUP_DIR', '/tmp/gantry-test-workspace');
    vi.stubEnv('GANTRY_WORKSPACE_EXTRA_DIR', '/tmp/gantry-test-extra');
    vi.stubEnv('GANTRY_IPC_DIR', '/tmp/gantry-test-ipc');

    const groupFolder = 'team-main';
    const threadId = 'thread-7';
    const { createIpcAuthEnvelope, getIpcResponseSigningPrivateKey } =
      await import('@core/runtime/ipc-auth.js');
    const { parsePermissionIpcRequest } =
      await import('@core/runtime/ipc-parsing.js');
    const { signIpcResponsePayload } =
      await import('@core/infrastructure/ipc/response-signing.js');

    const envelope = createIpcAuthEnvelope(groupFolder, threadId, {
      appId: 'app:team',
      agentId: 'agent:team-main',
    });
    vi.stubEnv('GANTRY_IPC_AUTH_TOKEN', envelope.authToken);
    vi.stubEnv('GANTRY_IPC_RESPONSE_VERIFY_KEY', envelope.responseVerifyKey);
    vi.stubEnv('GANTRY_IPC_RESPONSE_KEY_ID', envelope.responseKeyId);
    vi.stubEnv('GANTRY_PERMISSION_TIMEOUT_MS', '10000');

    vi.resetModules();
    const { setActiveRunnerSocketClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/active-runner-socket.js');
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    setActiveRunnerSocketClient({
      connected: true,
      request: vi.fn(async (channel, signedPayload) => {
        expect(channel).toBe('permission');
        const parsedRequest = parsePermissionIpcRequest(
          signedPayload,
          groupFolder,
        );
        expect(parsedRequest).toMatchObject({
          appId: 'app:team',
          agentId: 'agent:team-main',
          sourceAgentFolder: groupFolder,
          threadId,
          toolName: 'WebFetch',
          toolInput: {
            url: 'https://example.internal/dashboard',
            apiKey: '[REDACTED]',
            nested: { password: '[REDACTED]' },
          },
        });

        const responsePayload = {
          requestId: parsedRequest.requestId,
          responseNonce: parsedRequest.responseNonce,
          approved: true,
          mode: 'allow_once',
          decidedBy: 'admin:lead',
          reason: 'Approved for one-time access',
          decisionClassification: 'user_temporary',
        };
        const signingKey = getIpcResponseSigningPrivateKey(
          groupFolder,
          threadId,
          parsedRequest.responseKeyId,
        );
        expect(signingKey).toBeTruthy();
        return {
          ...responsePayload,
          signature: signIpcResponsePayload(
            signingKey as string,
            responsePayload,
          ),
        };
      }),
    });

    await expect(
      requestPermissionApproval({
        appId: 'app:team',
        agentId: 'agent:team-main',
        groupFolder,
        threadId,
        toolName: 'WebFetch',
        title: 'Fetch internal dashboard',
        decisionReason: 'Needs navigation to complete the task',
        toolInput: {
          url: 'https://example.internal/dashboard',
          apiKey: 'sk-sensitive-key',
          nested: { password: 'top-secret' },
        },
      }),
    ).resolves.toEqual({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'admin:lead',
      reason: 'Approved for one-time access',
      decisionClassification: 'user_temporary',
      updatedPermissions: undefined,
      timedGrantExpiresAtMs: undefined,
    });
  });

  it('fails closed when the socket response signature is missing', async () => {
    vi.stubEnv('GANTRY_IPC_AUTH_SECRET', 'perm-ipc-secret');
    vi.stubEnv('GANTRY_WORKSPACE_GROUP_DIR', '/tmp/gantry-test-workspace');
    vi.stubEnv('GANTRY_WORKSPACE_EXTRA_DIR', '/tmp/gantry-test-extra');
    vi.stubEnv('GANTRY_IPC_DIR', '/tmp/gantry-test-ipc');

    const groupFolder = 'team-main';
    const { createIpcAuthEnvelope } = await import('@core/runtime/ipc-auth.js');
    const envelope = createIpcAuthEnvelope(groupFolder, undefined, {
      appId: 'app:team',
      agentId: 'agent:team-main',
    });
    vi.stubEnv('GANTRY_IPC_AUTH_TOKEN', envelope.authToken);
    vi.stubEnv('GANTRY_IPC_RESPONSE_VERIFY_KEY', envelope.responseVerifyKey);
    vi.stubEnv('GANTRY_IPC_RESPONSE_KEY_ID', envelope.responseKeyId);
    vi.stubEnv('GANTRY_PERMISSION_TIMEOUT_MS', '10000');

    vi.resetModules();
    const { setActiveRunnerSocketClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/active-runner-socket.js');
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    setActiveRunnerSocketClient({
      connected: true,
      request: vi.fn(async (_channel, signedPayload) => ({
        requestId:
          typeof signedPayload.requestId === 'string'
            ? signedPayload.requestId
            : 'missing',
        responseNonce:
          typeof signedPayload.responseNonce === 'string'
            ? signedPayload.responseNonce
            : 'missing',
        approved: true,
        decidedBy: 'admin:lead',
      })),
    });

    await expect(
      requestPermissionApproval({
        appId: 'app:team',
        agentId: 'agent:team-main',
        groupFolder,
        toolName: 'edit_file',
      }),
    ).resolves.toEqual({
      approved: false,
      reason: 'Permission response signature verification failed',
    });
  });
});
