import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createIpcResponseSigningKeyPair } from '@core/infrastructure/ipc/response-signing.js';
import { IpcRequestError } from '@core/shared/ipc-socket-client.js';
import type {
  TaskResponseEnvelope,
  TaskSocketClientLike,
} from '@agent-runner-src/mcp/ipc.js';

// context.ts (loaded transitively by ipc.ts) requires GANTRY_IPC_DIR at module
// load. Set the env, THEN dynamically import the module under test so the
// static (hoisted) import order can't evaluate context.ts before the env.
const IPC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-send-task-'));
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const responseSigningKey = createIpcResponseSigningKeyPair();

let sendTaskRequest: typeof import('@agent-runner-src/mcp/ipc.js').sendTaskRequest;
let classifyTaskSocketError: typeof import('@agent-runner-src/mcp/ipc.js').classifyTaskSocketError;
let buildSignedTaskEnvelope: typeof import('@agent-runner-src/mcp/ipc.js').buildSignedTaskEnvelope;
let __setTaskSocketClientForTest: typeof import('@agent-runner-src/mcp/ipc.js').__setTaskSocketClientForTest;

beforeAll(async () => {
  process.env.GANTRY_IPC_DIR = IPC_DIR;
  process.env.GANTRY_GROUP_FOLDER = process.env.GANTRY_GROUP_FOLDER ?? 'team';
  process.env.GANTRY_CHAT_JID = process.env.GANTRY_CHAT_JID ?? 'tg:team';
  // context.ts reads IPC_AUTH_TOKEN at module load and buildSignedTaskEnvelope
  // only stamps a `signature` when a non-empty token is present. Set it BEFORE
  // the dynamic import so the signed-envelope assertions exercise the real
  // HMAC-signing path (an empty token would legitimately omit the signature).
  process.env.GANTRY_IPC_AUTH_TOKEN =
    process.env.GANTRY_IPC_AUTH_TOKEN ?? 'mcp-task-test-token';
  process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY = responseSigningKey.publicKeyPem;
  const mod = await import('@agent-runner-src/mcp/ipc.js');
  sendTaskRequest = mod.sendTaskRequest;
  classifyTaskSocketError = mod.classifyTaskSocketError;
  buildSignedTaskEnvelope = mod.buildSignedTaskEnvelope;
  __setTaskSocketClientForTest = mod.__setTaskSocketClientForTest;
});

afterEach(() => {
  __setTaskSocketClientForTest(undefined);
  vi.restoreAllMocks();
  // Clear any legacy task request files between tests.
  fs.rmSync(TASKS_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// classifyTaskSocketError — the full branch matrix, deterministically.
// ---------------------------------------------------------------------------

describe('classifyTaskSocketError', () => {
  it('maps a timeout to null (caller sees a timed-out task)', () => {
    const d = classifyTaskSocketError(
      'task-1',
      new IpcRequestError('request timed out', 'timeout'),
    );
    expect(d).toEqual({ kind: 'null' });
  });

  it.each(['connection_lost', 'not_connected', 'busy'])(
    'maps transient code %s to a bounded task error',
    (code) => {
      const d = classifyTaskSocketError(
        'task-1',
        new IpcRequestError('x', code),
      );
      expect(d).toEqual({
        kind: 'response',
        response: { taskId: 'task-1', ok: false, code, error: 'x' },
      });
    },
  );

  it('maps a non-protocol error to a bounded task error', () => {
    const d = classifyTaskSocketError('task-1', new Error('boom'));
    expect(d).toEqual({
      kind: 'response',
      response: {
        taskId: 'task-1',
        ok: false,
        code: 'socket_error',
        error: 'boom',
      },
    });
  });

  it.each([
    ['bad_signature', 'bad response signature'],
    ['invalid_request', 'invalid_request'],
    ['internal_error', 'internal_error'],
    ['rate_limited', 'rate_limited'],
    ['error', 'host said no'],
  ])(
    'reconstructs a {ok:false} response for non-transient code %s',
    (code, message) => {
      const d = classifyTaskSocketError(
        'task-9',
        new IpcRequestError(message, code),
      );
      expect(d).toEqual({
        kind: 'response',
        response: { taskId: 'task-9', ok: false, code, error: message },
      });
    },
  );
});

// ---------------------------------------------------------------------------
// sendTaskRequest — socket-only boundary (no socket client).
// ---------------------------------------------------------------------------

describe('sendTaskRequest (socket-only boundary)', () => {
  it('returns a bounded error and writes no task file when no socket client is available', async () => {
    __setTaskSocketClientForTest(null);
    const resp = await sendTaskRequest(
      { type: 'noop', taskId: 'no-client-1' },
      { timeoutMs: 60 },
    );
    expect(resp).toEqual<TaskResponseEnvelope>({
      taskId: 'no-client-1',
      ok: false,
      code: 'not_connected',
      error: 'IPC socket is not connected',
    });
    expect(fs.existsSync(TASKS_DIR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendTaskRequest — socket path with an injected fake client.
// ---------------------------------------------------------------------------

class FakeTaskSocketClient implements TaskSocketClientLike {
  connected = false;
  connectCalls = 0;
  requestCalls: Array<{
    channel: string;
    id?: string;
    timeoutMs?: number;
    payload: Record<string, unknown>;
  }> = [];

  constructor(
    private readonly behavior: {
      connectFails?: boolean;
      onRequest: (
        payload: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    },
  ) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.behavior.connectFails) {
      throw new IpcRequestError('connection lost: x', 'connection_lost');
    }
    this.connected = true;
  }

  async request(
    channel: 'task',
    signedPayload: Record<string, unknown>,
    opts?: { id?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    this.requestCalls.push({
      channel,
      id: opts?.id,
      timeoutMs: opts?.timeoutMs,
      payload: signedPayload,
    });
    return this.behavior.onRequest(signedPayload);
  }
}

describe('sendTaskRequest (socket mode, injected fake client)', () => {
  it('connects, sends the signed envelope as a task req, returns the resp', async () => {
    const fake = new FakeTaskSocketClient({
      onRequest: async () => ({
        taskId: 'sock-1',
        ok: true,
        message: 'done',
        data: { hello: 'world' },
        signature: 'sig',
      }),
    });
    __setTaskSocketClientForTest(fake);

    const resp = await sendTaskRequest(
      { type: 'scheduler_list_jobs', taskId: 'sock-1', chatJid: 'tg:team' },
      { timeoutMs: 300_000 },
    );

    expect(fake.connectCalls).toBe(1);
    expect(fake.requestCalls).toHaveLength(1);
    const call = fake.requestCalls[0];
    expect(call.channel).toBe('task');
    // R6: the 300s caller timeout is forwarded verbatim (not clamped to 15s).
    expect(call.timeoutMs).toBe(300_000);
    // The socket request id correlates with the signed envelope's requestId.
    expect(call.id).toBe(String(call.payload.requestId));
    // The payload is the signed envelope (HMAC signature + freshness stamps).
    expect(typeof call.payload.signature).toBe('string');
    expect(call.payload.type).toBe('scheduler_list_jobs');

    expect(resp).toMatchObject({
      taskId: 'sock-1',
      ok: true,
      message: 'done',
      data: { hello: 'world' },
    });
    // No fs request file is written on the socket happy path.
    expect(fs.existsSync(TASKS_DIR)).toBe(false);
  });

  it('maps a socket timeout to null without falling back to fs', async () => {
    const fake = new FakeTaskSocketClient({
      onRequest: async () => {
        throw new IpcRequestError('request timed out', 'timeout');
      },
    });
    __setTaskSocketClientForTest(fake);

    const resp = await sendTaskRequest(
      { type: 'noop', taskId: 'sock-timeout' },
      { timeoutMs: 5000 },
    );

    expect(resp).toBeNull();
    expect(fs.existsSync(TASKS_DIR)).toBe(false); // no request file on timeout
  });

  it('returns a reconstructed {ok:false} for a signed handler rejection', async () => {
    const fake = new FakeTaskSocketClient({
      onRequest: async () => {
        // Mirrors IpcSocketClient.handleResp on a signed {ok:false}: rejects
        // with IpcRequestError(message=error, code).
        throw new IpcRequestError('host rejected it', 'forbidden');
      },
    });
    __setTaskSocketClientForTest(fake);

    const resp = await sendTaskRequest(
      { type: 'noop', taskId: 'sock-reject' },
      { timeoutMs: 5000 },
    );

    expect(resp).toEqual<TaskResponseEnvelope>({
      taskId: 'sock-reject',
      ok: false,
      code: 'forbidden',
      error: 'host rejected it',
    });
    expect(fs.existsSync(TASKS_DIR)).toBe(false); // a real rejection is final
  });

  it('returns a bounded error and writes no task file on a transient socket failure', async () => {
    const fake = new FakeTaskSocketClient({
      onRequest: async () => {
        throw new IpcRequestError('connection lost: drop', 'connection_lost');
      },
    });
    __setTaskSocketClientForTest(fake);

    const pending = sendTaskRequest(
      { type: 'noop', taskId: 'sock-drop' },
      { timeoutMs: 3000 },
    );

    const resp = await pending;
    expect(resp).toEqual<TaskResponseEnvelope>({
      taskId: 'sock-drop',
      ok: false,
      code: 'connection_lost',
      error: 'connection lost: drop',
    });
    expect(fake.requestCalls).toHaveLength(1); // socket was attempted first
    expect(fs.existsSync(TASKS_DIR)).toBe(false);
  });

  it('returns a bounded error and writes no task file when the socket connect fails', async () => {
    const fake = new FakeTaskSocketClient({
      connectFails: true,
      onRequest: async () => ({ ok: true }),
    });
    __setTaskSocketClientForTest(fake);

    const pending = sendTaskRequest(
      { type: 'noop', taskId: 'connect-fail' },
      { timeoutMs: 3000 },
    );

    const resp = await pending;
    expect(resp).toEqual<TaskResponseEnvelope>({
      taskId: 'connect-fail',
      ok: false,
      code: 'not_connected',
      error: 'IPC socket is not connected',
    });
    expect(fake.connectCalls).toBe(1);
    expect(fake.requestCalls).toHaveLength(0); // never reached request()
    expect(fs.existsSync(TASKS_DIR)).toBe(false);
  });

  it('does not write a task request file on connection_lost', async () => {
    const fake = new FakeTaskSocketClient({
      onRequest: async () => {
        throw new IpcRequestError('connection lost: drop', 'connection_lost');
      },
    });
    __setTaskSocketClientForTest(fake);

    const resp = await sendTaskRequest(
      { type: 'noop', taskId: 'pure-socket-drop' },
      { timeoutMs: 60 },
    );

    expect(resp).toEqual<TaskResponseEnvelope>({
      taskId: 'pure-socket-drop',
      ok: false,
      code: 'connection_lost',
      error: 'connection lost: drop',
    });
    expect(fs.existsSync(TASKS_DIR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSignedTaskEnvelope — used by both transports (byte-identical wire).
// ---------------------------------------------------------------------------

describe('buildSignedTaskEnvelope', () => {
  it('merges context and stamps requestId/nonce/expiresAt', () => {
    const env = buildSignedTaskEnvelope({
      type: 'noop',
      taskId: 't1',
      context: { existing: 'kept' },
    });
    expect(env.type).toBe('noop');
    expect(env.taskId).toBe('t1');
    expect((env.context as Record<string, unknown>).existing).toBe('kept');
    expect(typeof env.requestId).toBe('string');
    expect(typeof env.nonce).toBe('string');
    expect(typeof env.expiresAt).toBe('string');
  });
});
