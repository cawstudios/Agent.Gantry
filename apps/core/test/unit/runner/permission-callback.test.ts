import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@core/adapters/llm/anthropic-claude-agent/runner/ipc-signing.js',
  async () => {
    const actual = await vi.importActual<
      typeof import('@core/adapters/llm/anthropic-claude-agent/runner/ipc-signing.js')
    >('@core/adapters/llm/anthropic-claude-agent/runner/ipc-signing.js');
    return {
      ...actual,
      hasValidIpcResponseSignature: vi.fn(() => true),
    };
  },
);

describe('requestPermissionApproval', () => {
  let tempDir: string;
  let oldEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetModules();
    oldEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-permission-'));
    process.env.GANTRY_WORKSPACE_GROUP_DIR = path.join(tempDir, 'workspace');
    process.env.GANTRY_WORKSPACE_EXTRA_DIR = path.join(tempDir, 'extra');
    process.env.GANTRY_IPC_DIR = path.join(tempDir, 'ipc');
    process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY = 'test-key';
    process.env.GANTRY_IPC_RESPONSE_KEY_ID = 'test-response-key';
    process.env.GANTRY_AGENT_RUN_HANDLE = 'run-handle-1';
  });

  afterEach(() => {
    process.env = oldEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('shares one timed-grant approval across identical concurrent same-run permission requests', async () => {
    const { setActiveRunnerSocketClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/active-runner-socket.js');
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');
    const fakeClient = {
      connected: true,
      request: vi.fn(
        async (
          _channel: 'permission',
          payload: Record<string, unknown>,
          opts?: { id?: string },
        ) =>
          ({
            requestId: String(opts?.id),
            responseNonce: payload.responseNonce,
            approved: true,
            mode: 'allow_timed_grant',
            decidedBy: 'Ravi',
            timedGrantExpiresAtMs: Date.now() + 60_000,
            signature: 'test-signature',
          }) as Record<string, unknown>,
      ),
    };
    setActiveRunnerSocketClient(fakeClient);

    const first = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      groupFolder: 'main_agent',
      targetJid: 'tg:test',
      threadId: 'topic-1',
      toolName: 'Bash',
      toolInput: { command: 'find ~/persona -type f' },
    });
    const second = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      groupFolder: 'main_agent',
      targetJid: 'tg:test',
      threadId: 'topic-2',
      toolName: 'Bash',
      toolInput: { command: 'find ~/persona -type f' },
    });

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    expect(firstDecision.mode).toBe('allow_timed_grant');
    expect(secondDecision.mode).toBe('allow_timed_grant');
    expect(fakeClient.request).toHaveBeenCalledTimes(1);
    expect(
      fs.existsSync(
        path.join(tempDir, 'ipc', 'main_agent', 'permission-requests'),
      ),
    ).toBe(false);
  });

  it('does not reuse a denial for a different requested tool in the same run', async () => {
    const { setActiveRunnerSocketClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/active-runner-socket.js');
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');
    const fakeClient = {
      connected: true,
      request: vi.fn(
        async (
          _channel: 'permission',
          payload: Record<string, unknown>,
          opts?: { id?: string },
        ) => {
          const approved = payload.toolName === 'Browser';
          return {
            requestId: String(opts?.id),
            responseNonce: payload.responseNonce,
            approved,
            mode: approved ? 'allow_once' : 'cancel',
            decidedBy: 'Ravi',
            reason: approved ? 'approved' : 'denied bash',
            signature: 'test-signature',
          } as Record<string, unknown>;
        },
      ),
    };
    setActiveRunnerSocketClient(fakeClient);

    const first = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      groupFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'find ~/persona -type f' },
    });

    const firstDecision = await first;
    expect(firstDecision.approved).toBe(false);

    const second = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      groupFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Browser',
      toolInput: { url: 'https://example.com' },
    });

    const secondDecision = await second;
    expect(secondDecision.approved).toBe(true);
    expect(secondDecision.mode).toBe('allow_once');
    expect(fakeClient.request).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Socket fast-path (Pillar 1, Phase 5.3d)
//
// When the run's runner socket client (published via setActiveRunnerSocketClient)
// is connected, requestPermissionApproval sends the SAME signed envelope over
// that ONE runner connection and maps the verified signed decision — writing NO
// permission-request file. Socket failure denies boundedly instead of writing an
// orphaned filesystem request.
// hasValidIpcResponseSignature is mocked to true (the transport-level signature
// is exercised by the socket-server test); this isolates the callback's branch.
// ---------------------------------------------------------------------------

describe('requestPermissionApproval socket fast-path', () => {
  let tempDir: string;
  let oldEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetModules();
    oldEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-permission-sock-'));
    process.env.GANTRY_WORKSPACE_GROUP_DIR = path.join(tempDir, 'workspace');
    process.env.GANTRY_WORKSPACE_EXTRA_DIR = path.join(tempDir, 'extra');
    process.env.GANTRY_IPC_DIR = path.join(tempDir, 'ipc');
    process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY = 'test-key';
    process.env.GANTRY_IPC_RESPONSE_KEY_ID = 'test-response-key';
    process.env.GANTRY_AGENT_RUN_HANDLE = 'run-handle-1';
    process.env.GANTRY_IPC_SOCKET_PATH = path.join(tempDir, 'core.sock');
  });

  afterEach(() => {
    process.env = oldEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends the permission request over the connected runner socket and writes no request file', async () => {
    const { setActiveRunnerSocketClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/active-runner-socket.js');
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const sent: Array<{
      channel: string;
      payload: Record<string, unknown>;
      id?: string;
    }> = [];
    const fakeClient = {
      connected: true,
      request: vi.fn(
        async (
          channel: 'permission',
          payload: Record<string, unknown>,
          opts?: { id?: string; timeoutMs?: number },
        ) => {
          sent.push({ channel, payload, id: opts?.id });
          // Echo a signed decision keyed to the request's id + responseNonce.
          const requestId = String(opts?.id);
          return {
            requestId,
            responseNonce: payload.responseNonce,
            approved: true,
            mode: 'allow_once',
            decidedBy: 'Ravi',
            reason: 'looks fine',
            signature: 'sig-from-host',
          } as Record<string, unknown>;
        },
      ),
    };
    setActiveRunnerSocketClient(fakeClient);

    const decision = await requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      groupFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });

    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe('allow_once');
    expect(decision.decidedBy).toBe('Ravi');

    // The request went over the socket exactly once on the `permission` channel,
    // and the correlation id matches the signed envelope's requestId.
    expect(fakeClient.request).toHaveBeenCalledTimes(1);
    expect(sent[0].channel).toBe('permission');
    expect(sent[0].payload.requestId).toBe(sent[0].id);
    expect(String(sent[0].id)).toMatch(/^perm-/);

    // No permission-request file was written.
    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const requestFiles = fs.existsSync(requestDir)
      ? fs.readdirSync(requestDir).filter((f) => f.endsWith('.json'))
      : [];
    expect(requestFiles).toHaveLength(0);
  });

  it('denies and writes no request file when the socket request fails', async () => {
    const { setActiveRunnerSocketClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/active-runner-socket.js');
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const fakeClient = {
      connected: true,
      request: vi.fn(async () => {
        throw new Error('connection lost: socket_error');
      }),
    };
    setActiveRunnerSocketClient(fakeClient);

    const pending = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      groupFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });

    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('connection lost: socket_error');
    expect(fakeClient.request).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(requestDir)).toBe(false);
  });

  it('denies without a request file when the active client is not connected', async () => {
    const { setActiveRunnerSocketClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/active-runner-socket.js');
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const fakeClient = {
      connected: false,
      request: vi.fn(async () => ({}) as Record<string, unknown>),
    };
    setActiveRunnerSocketClient(fakeClient);

    const pending = requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      groupFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });

    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const decision = await pending;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/socket/i);
    expect(fakeClient.request).not.toHaveBeenCalled();
    expect(fs.existsSync(requestDir)).toBe(false);
  });

  it('denies without a request file when the active client is not connected for a job', async () => {
    process.env.GANTRY_JOB_ID = 'job-1';
    process.env.GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS = '1';
    const { setActiveRunnerSocketClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/active-runner-socket.js');
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const fakeClient = {
      connected: false,
      request: vi.fn(async () => ({}) as Record<string, unknown>),
    };
    setActiveRunnerSocketClient(fakeClient);

    const decision = await requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      groupFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });

    expect(decision.approved).toBe(false);
    expect(decision.decisionClassification).toBe('user_reject');
    expect(decision.reason).toMatch(/socket/i);
    expect(fakeClient.request).not.toHaveBeenCalled();
    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const requestFiles = fs.existsSync(requestDir)
      ? fs.readdirSync(requestDir).filter((f) => f.endsWith('.json'))
      : [];
    expect(requestFiles).toHaveLength(0);
  });

  it('denies without a request file when the socket request drops for a job', async () => {
    process.env.GANTRY_JOB_ID = 'job-1';
    process.env.GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS = '1';
    const { IpcRequestError } =
      await import('@core/shared/ipc-socket-client.js');
    const { setActiveRunnerSocketClient } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/active-runner-socket.js');
    const { requestPermissionApproval } =
      await import('@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js');

    const fakeClient = {
      connected: true,
      request: vi.fn(async () => {
        throw new IpcRequestError('connection lost: drop', 'connection_lost');
      }),
    };
    setActiveRunnerSocketClient(fakeClient);

    const decision = await requestPermissionApproval({
      appId: 'default',
      agentId: 'agent:main_agent',
      groupFolder: 'main_agent',
      targetJid: 'tg:test',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });

    expect(decision.approved).toBe(false);
    expect(decision.decisionClassification).toBe('user_reject');
    expect(decision.reason).toContain('connection lost: drop');
    expect(fakeClient.request).toHaveBeenCalledTimes(1);
    const requestDir = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const requestFiles = fs.existsSync(requestDir)
      ? fs.readdirSync(requestDir).filter((f) => f.endsWith('.json'))
      : [];
    expect(requestFiles).toHaveLength(0);
  });
});
