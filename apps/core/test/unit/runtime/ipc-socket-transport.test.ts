import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// processTaskIpc is mocked so the test controls exactly what the task handler
// does (it normally fans out to the real scheduler/admin handlers). In the
// success path the mock calls the REAL writeTaskIpcResponse, exercising the
// response-router → signed-resp-frame path end to end.
vi.mock('@core/jobs/ipc-handler.js', () => ({
  processTaskIpc: vi.fn(),
}));

// Partially mock the memory module: processMemoryRequest is stubbed so the test
// controls the response WITHOUT standing up the Postgres-backed memory service,
// but writeMemoryResponse stays REAL so the response-router → signed-resp-frame
// path is exercised end to end (exactly as the task test uses the real
// writeTaskIpcResponse).
vi.mock('@core/memory/memory-ipc.js', async (importActual) => {
  const actual =
    await importActual<typeof import('@core/memory/memory-ipc.js')>();
  return { ...actual, processMemoryRequest: vi.fn() };
});

// Partially mock the browser handler: processBrowserIpcRequest is stubbed so the
// test controls the backend response (and its timing, for the in-flight cap)
// WITHOUT standing up Chrome/CDP, but writeBrowserIpcResponse stays REAL so the
// response-router → signed-resp-frame path is exercised end to end (exactly as
// the memory test keeps writeMemoryResponse real). runBrowserIpcRequest in
// ipc-browser-requests.ts consumes both from this module, so the socket
// dispatcher runs the real router-aware writer.
vi.mock('@core/runtime/ipc-browser-handler.js', async (importActual) => {
  const actual =
    await importActual<typeof import('@core/runtime/ipc-browser-handler.js')>();
  return { ...actual, processBrowserIpcRequest: vi.fn() };
});

import { processTaskIpc } from '@core/jobs/ipc-handler.js';
import { writeTaskIpcResponse } from '@core/jobs/ipc-shared.js';
import { processMemoryRequest } from '@core/memory/memory-ipc.js';
import { processBrowserIpcRequest } from '@core/runtime/ipc-browser-handler.js';
import {
  computeBrowserIpcAuthToken,
  computeMemoryIpcAuthToken,
  registerBrowserIpcAuthorization,
  revokeBrowserIpcAuthorization,
} from '@core/runtime/ipc-auth.js';
import { clearBrowserInFlight } from '@core/runtime/ipc-browser-inflight.js';
import { normalizeMemoryIpcActions } from '@core/shared/memory-ipc-actions.js';
import type { MemoryIpcResponse } from '@gantry/contracts';
import {
  startIpcSocketServer,
  type IpcSocketServerHandle,
} from '@core/runtime/ipc-socket-server.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { createSignedIpcRequestEnvelope } from '@core/runner/mcp/signing.js';
import { verifyIpcResponsePayload } from '@core/infrastructure/ipc/response-signing.js';
import { encodeFrame, FrameDecoder } from '@core/shared/ipc-frame.js';
import {
  encodeWireFrame,
  parseWireFrame,
  type IpcWireFrame,
  type IpcWireChannel,
} from '@core/shared/ipc-wire.js';
import { clearIpcResponders } from '@core/runtime/ipc-response-router.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import { clearIpcRateLimitState } from '@core/runtime/ipc-rate-limit.js';

const processTaskIpcMock = vi.mocked(processTaskIpc);
const processMemoryRequestMock = vi.mocked(processMemoryRequest);
const processBrowserIpcRequestMock = vi.mocked(processBrowserIpcRequest);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FOLDER = 'group-test';
const OTHER_FOLDER = 'group-other';
const CHAT_JID = 'wa:1555000@test';
const THREAD_ID = 'thread-abc';

function buildDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  const routes: Record<string, ConversationRoute> = {
    [CHAT_JID]: {
      name: 'Test Group',
      folder: FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
    },
  };
  const deps = {
    sendMessage: vi.fn(async () => undefined),
    conversationRoutes: () => routes,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(async () => undefined),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onSchedulerChanged: vi.fn(),
    requestPermissionApproval: vi.fn(async () => ({}) as never),
    requestUserAnswer: vi.fn(async () => ({}) as never),
    opsRepository: {} as never,
    ...overrides,
  } as unknown as IpcDeps;
  return deps;
}

// ---------------------------------------------------------------------------
// Fake worker client — real net.connect, framed wire protocol, promise-based
// frame reads.
// ---------------------------------------------------------------------------

class FakeWorkerClient {
  private readonly socket: net.Socket;
  private readonly decoder = new FrameDecoder();
  private readonly inbound: IpcWireFrame[] = [];
  private waiters: Array<(frame: IpcWireFrame) => void> = [];
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      let bodies: Buffer[];
      try {
        bodies = this.decoder.push(chunk);
      } catch {
        return;
      }
      for (const body of bodies) {
        let frame: IpcWireFrame;
        try {
          frame = parseWireFrame(body.toString('utf8'));
        } catch {
          continue;
        }
        // Auto-answer server heartbeat pings so the connection stays alive.
        if (frame.type === 'ctrl' && frame.ctrl === 'ping') {
          this.sendRaw({
            v: 1,
            type: 'ctrl',
            channel: null,
            ctrl: 'pong',
            id: frame.id,
            payload: {},
          });
          continue;
        }
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.inbound.push(frame);
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      this.closed = true;
    });
  }

  static connect(socketPath: string): Promise<FakeWorkerClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const onErr = (err: Error) => reject(err);
      socket.once('error', onErr);
      socket.once('connect', () => {
        socket.removeListener('error', onErr);
        resolve(new FakeWorkerClient(socket));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  sendRaw(frame: IpcWireFrame): void {
    const body = Buffer.from(encodeWireFrame(frame), 'utf8');
    this.socket.write(encodeFrame(body));
  }

  /** Send a raw (non-frame-encoded) buffer to corrupt the wire. */
  sendBytes(buf: Buffer): void {
    this.socket.write(buf);
  }

  sendHello(signedPayload: Record<string, unknown>, id = 'hello-1'): void {
    this.sendRaw({
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'hello',
      id,
      payload: signedPayload,
    });
  }

  sendReq(
    channel: IpcWireChannel,
    signedPayload: Record<string, unknown>,
    id: string,
  ): void {
    this.sendRaw({ v: 1, type: 'req', channel, id, payload: signedPayload });
  }

  /** Resolve with the next inbound frame (FIFO with the buffer). */
  nextFrame(timeoutMs = 5000): Promise<IpcWireFrame> {
    const buffered = this.inbound.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onFrame);
        reject(new Error('nextFrame timeout'));
      }, timeoutMs);
      const onFrame = (frame: IpcWireFrame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(onFrame);
    });
  }

  /** Wait for a resp/ctrl frame whose id matches; skips non-matching frames. */
  async waitForId(id: string, timeoutMs = 5000): Promise<IpcWireFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`waitForId(${id}) timeout`);
      const frame = await this.nextFrame(remaining);
      if (frame.id === id) return frame;
    }
  }

  /** Resolve once the socket closes (server-side destroy). */
  waitClose(timeoutMs = 5000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('waitClose timeout')),
        timeoutMs,
      );
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// Envelope builders (shared auth context across hello + task payloads)
// ---------------------------------------------------------------------------

function makeAuth(folder: string, threadId: string | undefined) {
  return createIpcAuthEnvelope(folder, threadId);
}

function buildHelloPayload(
  authToken: string,
  opts: {
    folder: string;
    role?: 'runner' | 'mcp';
    threadId?: string;
    runHandle?: string;
    expiresAt?: string;
  },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(authToken, {
    kind: 'hello',
    role: opts.role ?? 'runner',
    runHandle: opts.runHandle ?? 'run-1',
    folder: opts.folder,
    context: { threadId: opts.threadId ?? null },
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
  });
}

function buildTaskPayload(
  authToken: string,
  responseKeyId: string,
  opts: { taskId: string; type: string; threadId?: string },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(authToken, {
    type: opts.type,
    taskId: opts.taskId,
    context: {
      threadId: opts.threadId ?? null,
      responseKeyId,
    },
  });
}

// --- Memory envelopes ------------------------------------------------------
// The memory channel has its OWN HMAC token (computeMemoryIpcAuthToken), bound
// to the folder + thread + chatJid/userId/scope + the EXACT allowedActions set
// + reviewer scope. The signed request must carry a context that re-derives the
// same token AND lists the action in allowedActions, or parseMemoryIpcRequest
// rejects it. This mirrors the grandchild's buildSignedMemoryEnvelope.
const MEMORY_ALLOWED_ACTIONS = normalizeMemoryIpcActions([
  'memory_search',
  'memory_save',
  'continuity_summary',
  'procedure_save',
]);
const MEMORY_CHAT_JID = CHAT_JID;
const MEMORY_DEFAULT_SCOPE = 'group' as const;

function memoryAuthToken(folder: string, threadId: string | undefined): string {
  return computeMemoryIpcAuthToken(folder, {
    chatJid: MEMORY_CHAT_JID,
    defaultScope: MEMORY_DEFAULT_SCOPE,
    threadId: threadId ?? null,
    allowedActions: MEMORY_ALLOWED_ACTIONS,
    reviewerIsControlApprover: false,
  });
}

function buildMemoryPayload(
  memoryToken: string,
  responseKeyId: string,
  opts: {
    requestId: string;
    action?: string;
    threadId?: string;
    payload?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(memoryToken, {
    requestId: opts.requestId,
    action: opts.action ?? 'memory_search',
    payload: opts.payload ?? { query: 'hello' },
    context: {
      chatJid: MEMORY_CHAT_JID,
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      responseKeyId,
      defaultScope: MEMORY_DEFAULT_SCOPE,
      allowedActions: MEMORY_ALLOWED_ACTIONS,
      reviewerIsControlApprover: false,
    },
  });
}

// --- User-question + message envelopes -------------------------------------
// Both share the SAME folder/thread auth token (computeIpcAuthToken) as task —
// validateIpcAuthRequest re-derives it. The user_question payload mirrors the
// grandchild's buildUserQuestionRequestPayload; the message payload mirrors the
// grandchild's buildSignedTaskEnvelope({ type:'message', ... }).

function buildUserQuestionPayload(
  authToken: string,
  responseKeyId: string,
  opts: {
    requestId: string;
    threadId?: string;
    targetJid?: string;
    questions?: unknown;
  },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(authToken, {
    requestId: opts.requestId,
    sourceAgentFolder: FOLDER,
    ...(opts.targetJid !== undefined ? { targetJid: opts.targetJid } : {}),
    questions: opts.questions ?? [
      {
        question: 'Ship now?',
        header: 'Deploy',
        options: [
          { label: 'Yes', description: 'Ship it' },
          { label: 'No', description: 'Wait' },
        ],
        multiSelect: false,
      },
    ],
    context: {
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      responseKeyId,
    },
  });
}

function buildMessagePayload(
  authToken: string,
  opts: { text: string; chatJid?: string; threadId?: string },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(authToken, {
    type: 'message',
    chatJid: opts.chatJid ?? CHAT_JID,
    text: opts.text,
    groupFolder: FOLDER,
    context: {
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
    },
  });
}

// --- Browser envelopes -----------------------------------------------------
// The browser channel has its OWN chat-scoped HMAC token
// (computeBrowserIpcAuthToken), bound to the folder + chatJid + thread. The
// signed request must carry context.chatJid (required by the parser) and a
// responseKeyId. This mirrors the grandchild's buildSignedBrowserEnvelope.
function browserAuthToken(
  folder: string,
  chatJid: string,
  threadId: string | undefined,
): string {
  return computeBrowserIpcAuthToken(folder, chatJid, threadId ?? null);
}

function buildBrowserPayload(
  browserToken: string,
  responseKeyId: string,
  opts: {
    requestId: string;
    action?: string;
    threadId?: string;
    chatJid?: string;
    payload?: Record<string, unknown>;
    timeoutMs?: number;
  },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(browserToken, {
    requestId: opts.requestId,
    action: opts.action ?? 'navigate',
    payload: opts.payload ?? { url: 'https://example.test' },
    context: {
      chatJid: opts.chatJid ?? CHAT_JID,
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      responseKeyId,
    },
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let server: IpcSocketServerHandle | undefined;
const clients: FakeWorkerClient[] = [];

function socketPathFor(name = 'core.sock'): string {
  return path.join(tmpDir, name);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-socket-transport-'));
  processTaskIpcMock.mockReset();
  processMemoryRequestMock.mockReset();
  processBrowserIpcRequestMock.mockReset();
  clearIpcResponders();
  clearConsumedIpcRequestIds();
  clearIpcRateLimitState();
  clearBrowserInFlight();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  if (server) {
    await server.stop().catch(() => undefined);
    server = undefined;
  }
  clearIpcResponders();
  clearConsumedIpcRequestIds();
  clearIpcRateLimitState();
  clearBrowserInFlight();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function startServer(
  deps: IpcDeps,
  opts: Parameters<typeof startIpcSocketServer>[1] = {},
): Promise<IpcSocketServerHandle> {
  const handle = await startIpcSocketServer(deps, {
    socketPath: socketPathFor(),
    ...opts,
  });
  if (!handle) throw new Error('server failed to start');
  server = handle;
  return handle;
}

async function connect(
  handle: IpcSocketServerHandle,
): Promise<FakeWorkerClient> {
  const client = await FakeWorkerClient.connect(handle.socketPath);
  clients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// 1. Handshake success
// ---------------------------------------------------------------------------

describe('ipc-socket-server handshake', () => {
  it('1. accepts a valid hello and replies ctrl:welcome', async () => {
    const handle = await startServer(buildDeps());
    const client = await connect(handle);
    const auth = makeAuth(FOLDER, THREAD_ID);
    client.sendHello(
      buildHelloPayload(auth.authToken, {
        folder: FOLDER,
        threadId: THREAD_ID,
      }),
      'hello-1',
    );

    const welcome = await client.waitForId('hello-1');
    expect(welcome.type).toBe('ctrl');
    expect(welcome.ctrl).toBe('welcome');
    expect(handle.connectionsForFolder(FOLDER).length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Handshake failures
  // -------------------------------------------------------------------------

  it('2a. rejects a hello signed with the wrong token (forged signature)', async () => {
    const handle = await startServer(buildDeps());
    const client = await connect(handle);
    // Sign with a token derived from a DIFFERENT folder → signature mismatch.
    const wrongAuth = makeAuth('group-evil', THREAD_ID);
    client.sendHello(
      buildHelloPayload(wrongAuth.authToken, {
        folder: FOLDER,
        threadId: THREAD_ID,
      }),
    );

    await client.waitClose();
    expect(client.isClosed).toBe(true);
    expect(handle.connectionsForFolder(FOLDER).length).toBe(0);
  });

  it('2b. rejects a hello for an unregistered folder', async () => {
    const handle = await startServer(buildDeps());
    const client = await connect(handle);
    const auth = makeAuth(OTHER_FOLDER, THREAD_ID);
    client.sendHello(
      buildHelloPayload(auth.authToken, {
        folder: OTHER_FOLDER,
        threadId: THREAD_ID,
      }),
    );

    await client.waitClose();
    expect(client.isClosed).toBe(true);
  });

  it('2c. rejects an expired hello', async () => {
    const handle = await startServer(buildDeps());
    const client = await connect(handle);
    const auth = makeAuth(FOLDER, THREAD_ID);
    const past = new Date(Date.now() - 60_000).toISOString();
    client.sendHello(
      buildHelloPayload(auth.authToken, {
        folder: FOLDER,
        threadId: THREAD_ID,
        expiresAt: past,
      }),
    );

    await client.waitClose();
    expect(client.isClosed).toBe(true);
  });

  it('2d. closes when the first frame is not a hello', async () => {
    const handle = await startServer(buildDeps());
    const client = await connect(handle);
    const auth = makeAuth(FOLDER, THREAD_ID);
    // A task req before any handshake.
    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-1',
        type: 'scheduler_list_jobs',
        threadId: THREAD_ID,
      }),
      'r1',
    );

    await client.waitClose();
    expect(client.isClosed).toBe(true);
  });

  it('2e. closes a handshakeless connection after the handshake timeout', async () => {
    const handle = await startServer(buildDeps(), { handshakeTimeoutMs: 150 });
    const client = await connect(handle);
    // Send nothing — the timeout should fire.
    await client.waitClose(3000);
    expect(client.isClosed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3-7. Task dispatch
// ---------------------------------------------------------------------------

describe('ipc-socket-server task dispatch', () => {
  async function handshake(
    handle: IpcSocketServerHandle,
    auth: ReturnType<typeof makeAuth>,
    threadId = THREAD_ID,
  ): Promise<FakeWorkerClient> {
    const client = await connect(handle);
    client.sendHello(
      buildHelloPayload(auth.authToken, { folder: FOLDER, threadId }),
      'hs',
    );
    const welcome = await client.waitForId('hs');
    expect(welcome.ctrl).toBe('welcome');
    return client;
  }

  it('3. task req → signed resp frame (router + ed25519 end to end)', async () => {
    // The mocked handler emulates a real handler: it calls writeTaskIpcResponse,
    // which finds the registered responder and delivers a signed payload.
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER,
        data.taskId,
        { ok: true, message: 'done' },
        data.authThreadId,
        data.responseKeyId,
      );
    });

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-7',
        type: 'scheduler_list_jobs',
        threadId: THREAD_ID,
      }),
      'req-7',
    );

    const resp = await client.waitForId('req-7');
    expect(resp.type).toBe('resp');
    expect(resp.channel).toBe('task');
    const { signature, ...payloadWithoutSig } = resp.payload as {
      signature?: string;
    } & Record<string, unknown>;
    expect(typeof signature).toBe('string');
    expect(
      verifyIpcResponsePayload(
        auth.responseVerifyKey,
        payloadWithoutSig,
        signature,
      ),
    ).toBe(true);
    expect(payloadWithoutSig.ok).toBe(true);
    expect(payloadWithoutSig.message).toBe('done');
    expect(processTaskIpcMock).toHaveBeenCalledTimes(1);
  });

  it('4. forged task req (wrong token) → transport-error resp, connection survives', async () => {
    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    // Sign the task with a token for a different folder → parseTaskIpcData throws.
    const wrongAuth = makeAuth('group-evil', THREAD_ID);
    client.sendReq(
      'task',
      buildTaskPayload(wrongAuth.authToken, auth.responseKeyId, {
        taskId: 'task-bad',
        type: 'scheduler_list_jobs',
        threadId: THREAD_ID,
      }),
      'req-bad',
    );

    const resp = await client.waitForId('req-bad');
    expect(resp.type).toBe('resp');
    expect((resp.payload as { ok?: boolean }).ok).toBe(false);
    expect(processTaskIpcMock).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);

    // Connection still usable: a valid req now gets a response.
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER,
        data.taskId,
        { ok: true, message: 'ok2' },
        data.authThreadId,
        data.responseKeyId,
      );
    });
    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-ok',
        type: 'scheduler_list_jobs',
        threadId: THREAD_ID,
      }),
      'req-ok',
    );
    const ok = await client.waitForId('req-ok');
    expect((ok.payload as { ok?: boolean }).ok).toBe(true);
  });

  it('5. replay of the same task req is rejected the second time', async () => {
    let handlerCalls = 0;
    processTaskIpcMock.mockImplementation(async (data) => {
      handlerCalls += 1;
      writeTaskIpcResponse(
        FOLDER,
        data.taskId,
        { ok: true, message: 'first' },
        data.authThreadId,
        data.responseKeyId,
      );
    });

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    const payload = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-replay',
      type: 'scheduler_list_jobs',
      threadId: THREAD_ID,
    });

    client.sendReq('task', payload, 'req-first');
    const first = await client.waitForId('req-first');
    expect((first.payload as { ok?: boolean }).ok).toBe(true);

    // Re-send the byte-identical payload under a new frame id → replay reject.
    client.sendReq('task', payload, 'req-second');
    const second = await client.waitForId('req-second');
    expect((second.payload as { ok?: boolean }).ok).toBe(false);
    // Handler ran exactly once (the replay never reached it).
    expect(handlerCalls).toBe(1);
  });

  it('6. unsupported channel → {ok:false, unsupported_channel}, connection survives', async () => {
    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    // `permission` is not yet cut over to the socket, so it remains the explicit
    // unsupported-channel reject (task/memory/user_question/browser now each have
    // their own dispatcher).
    client.sendReq(
      'permission',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'b1',
        type: 'noop',
        threadId: THREAD_ID,
      }),
      'req-unsup',
    );

    const resp = await client.waitForId('req-unsup');
    expect(resp.type).toBe('resp');
    expect((resp.payload as { ok?: boolean }).ok).toBe(false);
    expect((resp.payload as { code?: string }).code).toBe(
      'unsupported_channel',
    );
    expect(client.isClosed).toBe(false);
  });

  it('7. rate limit → a rate_limited resp appears, connection survives', async () => {
    // Exhaust the 300/60s limiter for this (folder,'tasks') bucket so the very
    // next task req is rejected at the transport layer without ever reaching
    // parseTaskIpcData.
    const { canProcessIpcFile } =
      await import('@core/runtime/ipc-rate-limit.js');
    for (let i = 0; i < 300; i += 1) canProcessIpcFile(FOLDER, 'tasks');

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'task-rl',
        type: 'scheduler_list_jobs',
        threadId: THREAD_ID,
      }),
      'req-rl',
    );

    const resp = await client.waitForId('req-rl');
    expect(resp.type).toBe('resp');
    expect((resp.payload as { ok?: boolean }).ok).toBe(false);
    expect((resp.payload as { code?: string }).code).toBe('rate_limited');
    expect(processTaskIpcMock).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Memory dispatch (Pillar 1, Phase 5.3a)
//
// processMemoryRequest is mocked (no Postgres); writeMemoryResponse is REAL, so
// the server's dispatchMemory → registerIpcResponder → writeMemoryResponse →
// signed-resp-frame path runs end to end. The memory channel keeps its OWN auth
// (memory HMAC token + replay scope + allowedActions), re-verified here by the
// real parseMemoryIpcRequest exactly as the fs watcher does.
// ---------------------------------------------------------------------------

describe('ipc-socket-server memory dispatch', () => {
  async function handshake(
    handle: IpcSocketServerHandle,
    auth: ReturnType<typeof makeAuth>,
    threadId = THREAD_ID,
  ): Promise<FakeWorkerClient> {
    const client = await connect(handle);
    client.sendHello(
      buildHelloPayload(auth.authToken, { folder: FOLDER, threadId }),
      'hs',
    );
    const welcome = await client.waitForId('hs');
    expect(welcome.ctrl).toBe('welcome');
    return client;
  }

  it('M1. memory req → signed resp frame (router + ed25519 end to end)', async () => {
    const response: MemoryIpcResponse = {
      ok: true,
      requestId: 'mem-7',
      provider: 'postgres',
      data: { results: [{ id: 'm-1' }] },
    };
    processMemoryRequestMock.mockResolvedValue(response);

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const memToken = memoryAuthToken(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    client.sendReq(
      'memory',
      buildMemoryPayload(memToken, auth.responseKeyId, {
        requestId: 'mem-7',
        action: 'memory_search',
        threadId: THREAD_ID,
      }),
      'req-mem-7',
    );

    const resp = await client.waitForId('req-mem-7');
    expect(resp.type).toBe('resp');
    expect(resp.channel).toBe('memory');
    const { signature, ...payloadWithoutSig } = resp.payload as {
      signature?: string;
    } & Record<string, unknown>;
    expect(typeof signature).toBe('string');
    expect(
      verifyIpcResponsePayload(
        auth.responseVerifyKey,
        payloadWithoutSig,
        signature,
      ),
    ).toBe(true);
    expect(payloadWithoutSig.ok).toBe(true);
    expect(payloadWithoutSig.requestId).toBe('mem-7');
    expect(payloadWithoutSig.provider).toBe('postgres');
    expect(payloadWithoutSig.data).toEqual({ results: [{ id: 'm-1' }] });

    // The handler ran exactly once, with the parser's trusted request shape.
    expect(processMemoryRequestMock).toHaveBeenCalledTimes(1);
    const [reqArg, folderArg] = processMemoryRequestMock.mock.calls[0];
    expect(folderArg).toBe(FOLDER);
    expect(reqArg).toEqual(
      expect.objectContaining({
        requestId: 'mem-7',
        action: 'memory_search',
        allowedActions: MEMORY_ALLOWED_ACTIONS,
      }),
    );

    // No memory-responses file was written — the responder consumed it.
    const responsesDir = path.join(
      process.env.GANTRY_HOME as string,
      'data',
      'ipc',
      FOLDER,
      'memory-responses',
    );
    expect(fs.existsSync(path.join(responsesDir, 'mem-7.json'))).toBe(false);
  });

  it('M2. forged memory req (wrong memory token) → {ok:false} reject, connection survives', async () => {
    processMemoryRequestMock.mockResolvedValue({
      ok: true,
      requestId: 'mem-ok',
      provider: 'postgres',
      data: { results: [] },
    } satisfies MemoryIpcResponse);

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    // Sign with a memory token bound to a DIFFERENT folder → signature mismatch
    // → parseMemoryIpcRequest throws → invalid_request, handler never runs.
    const wrongToken = memoryAuthToken('group-evil', THREAD_ID);
    client.sendReq(
      'memory',
      buildMemoryPayload(wrongToken, auth.responseKeyId, {
        requestId: 'mem-bad',
        threadId: THREAD_ID,
      }),
      'req-mem-bad',
    );

    const resp = await client.waitForId('req-mem-bad');
    expect(resp.type).toBe('resp');
    expect((resp.payload as { ok?: boolean }).ok).toBe(false);
    expect((resp.payload as { code?: string }).code).toBe('invalid_request');
    expect(processMemoryRequestMock).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);

    // Connection still usable: a valid memory req now gets a signed response.
    const memToken = memoryAuthToken(FOLDER, THREAD_ID);
    client.sendReq(
      'memory',
      buildMemoryPayload(memToken, auth.responseKeyId, {
        requestId: 'mem-ok',
        threadId: THREAD_ID,
      }),
      'req-mem-ok',
    );
    const ok = await client.waitForId('req-mem-ok');
    expect((ok.payload as { ok?: boolean }).ok).toBe(true);
  });

  it('M3. replay of the same memory req is rejected the second time', async () => {
    let handlerCalls = 0;
    processMemoryRequestMock.mockImplementation(async () => {
      handlerCalls += 1;
      return {
        ok: true,
        requestId: 'mem-replay',
        provider: 'postgres',
        data: { results: [] },
      } satisfies MemoryIpcResponse;
    });

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const memToken = memoryAuthToken(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    const payload = buildMemoryPayload(memToken, auth.responseKeyId, {
      requestId: 'mem-replay',
      threadId: THREAD_ID,
    });

    client.sendReq('memory', payload, 'req-first');
    const first = await client.waitForId('req-first');
    expect((first.payload as { ok?: boolean }).ok).toBe(true);

    // Re-send the byte-identical signed payload under a new frame id → the
    // memory replay guard (requestId already consumed) rejects it.
    client.sendReq('memory', payload, 'req-second');
    const second = await client.waitForId('req-second');
    expect((second.payload as { ok?: boolean }).ok).toBe(false);
    expect((second.payload as { code?: string }).code).toBe('invalid_request');
    expect(handlerCalls).toBe(1);
  });

  it('M4. memory rate limit → rate_limited resp, connection survives', async () => {
    const { canProcessIpcFile } =
      await import('@core/runtime/ipc-rate-limit.js');
    for (let i = 0; i < 300; i += 1) canProcessIpcFile(FOLDER, 'memory');

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const memToken = memoryAuthToken(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    client.sendReq(
      'memory',
      buildMemoryPayload(memToken, auth.responseKeyId, {
        requestId: 'mem-rl',
        threadId: THREAD_ID,
      }),
      'req-mem-rl',
    );

    const resp = await client.waitForId('req-mem-rl');
    expect(resp.type).toBe('resp');
    expect((resp.payload as { ok?: boolean }).ok).toBe(false);
    expect((resp.payload as { code?: string }).code).toBe('rate_limited');
    expect(processMemoryRequestMock).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// User-question dispatch (Pillar 1, Phase 5.3b)
//
// requestUserAnswer (the dep) is stubbed so the test controls the answer; the
// server runs the REAL processUserQuestionInteractionIpc → router-aware
// writeUserQuestionIpcResponse → signed-resp-frame path end to end. The
// user_question channel shares the folder/thread auth token (re-verified by the
// real parseUserQuestionIpcRequest exactly as the fs watcher does).
// ---------------------------------------------------------------------------

describe('ipc-socket-server user_question dispatch', () => {
  async function handshake(
    handle: IpcSocketServerHandle,
    auth: ReturnType<typeof makeAuth>,
    threadId = THREAD_ID,
  ): Promise<FakeWorkerClient> {
    const client = await connect(handle);
    client.sendHello(
      buildHelloPayload(auth.authToken, { folder: FOLDER, threadId }),
      'hs',
    );
    const welcome = await client.waitForId('hs');
    expect(welcome.ctrl).toBe('welcome');
    return client;
  }

  it('U1. user_question req → signed resp frame (router + ed25519 end to end)', async () => {
    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'userq-7',
      answers: { 'Ship now?': 'Yes' },
      answeredBy: 'admin',
    }));
    const handle = await startServer(buildDeps({ requestUserAnswer } as never));
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    client.sendReq(
      'user_question',
      buildUserQuestionPayload(auth.authToken, auth.responseKeyId, {
        requestId: 'userq-7',
        threadId: THREAD_ID,
        targetJid: CHAT_JID,
      }),
      'req-userq-7',
    );

    const resp = await client.waitForId('req-userq-7');
    expect(resp.type).toBe('resp');
    expect(resp.channel).toBe('user_question');
    const { signature, ...payloadWithoutSig } = resp.payload as {
      signature?: string;
    } & Record<string, unknown>;
    expect(typeof signature).toBe('string');
    expect(
      verifyIpcResponsePayload(
        auth.responseVerifyKey,
        payloadWithoutSig,
        signature,
      ),
    ).toBe(true);
    expect(payloadWithoutSig.requestId).toBe('userq-7');
    expect(payloadWithoutSig.answers).toEqual({ 'Ship now?': 'Yes' });
    expect(payloadWithoutSig.answeredBy).toBe('admin');

    // The dep ran exactly once, with the trusted parsed request (targetJid
    // preserved from the stamp → cross-conversation guard intact).
    expect(requestUserAnswer).toHaveBeenCalledTimes(1);
    const reqArg = requestUserAnswer.mock.calls[0][0] as {
      requestId: string;
      targetJid?: string;
      sourceAgentFolder: string;
    };
    expect(reqArg.requestId).toBe('userq-7');
    expect(reqArg.sourceAgentFolder).toBe(FOLDER);
    expect(reqArg.targetJid).toBe(CHAT_JID);

    // No user-answers file was written — the responder consumed it.
    const answersDir = path.join(
      process.env.GANTRY_HOME as string,
      'data',
      'ipc',
      FOLDER,
      'user-answers',
    );
    expect(fs.existsSync(path.join(answersDir, 'userq-7.json'))).toBe(false);
  });

  it('U2. forged user_question req (wrong token) → invalid_request, connection survives', async () => {
    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'userq-ok',
      answers: { 'Ship now?': 'Yes' },
    }));
    const handle = await startServer(buildDeps({ requestUserAnswer } as never));
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    // Sign with a token bound to a DIFFERENT folder → parseUserQuestionIpcRequest
    // throws → invalid_request, the dep never runs.
    const wrongAuth = makeAuth('group-evil', THREAD_ID);
    client.sendReq(
      'user_question',
      buildUserQuestionPayload(wrongAuth.authToken, auth.responseKeyId, {
        requestId: 'userq-bad',
        threadId: THREAD_ID,
        targetJid: CHAT_JID,
      }),
      'req-userq-bad',
    );

    const resp = await client.waitForId('req-userq-bad');
    expect(resp.type).toBe('resp');
    expect((resp.payload as { ok?: boolean }).ok).toBe(false);
    expect((resp.payload as { code?: string }).code).toBe('invalid_request');
    expect(requestUserAnswer).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);

    // Connection still usable: a valid user_question now gets a signed response.
    client.sendReq(
      'user_question',
      buildUserQuestionPayload(auth.authToken, auth.responseKeyId, {
        requestId: 'userq-ok',
        threadId: THREAD_ID,
        targetJid: CHAT_JID,
      }),
      'req-userq-ok',
    );
    const ok = await client.waitForId('req-userq-ok');
    expect(ok.channel).toBe('user_question');
    expect((ok.payload as { requestId?: string }).requestId).toBe('userq-ok');
  });

  it('U3. replay of the same user_question req is rejected the second time', async () => {
    let calls = 0;
    const requestUserAnswer = vi.fn(async () => {
      calls += 1;
      return { requestId: 'userq-replay', answers: { 'Ship now?': 'Yes' } };
    });
    const handle = await startServer(buildDeps({ requestUserAnswer } as never));
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    const payload = buildUserQuestionPayload(
      auth.authToken,
      auth.responseKeyId,
      {
        requestId: 'userq-replay',
        threadId: THREAD_ID,
        targetJid: CHAT_JID,
      },
    );

    client.sendReq('user_question', payload, 'req-first');
    const first = await client.waitForId('req-first');
    expect((first.payload as { requestId?: string }).requestId).toBe(
      'userq-replay',
    );

    // Re-send the byte-identical signed payload → replay guard rejects it.
    client.sendReq('user_question', payload, 'req-second');
    const second = await client.waitForId('req-second');
    expect((second.payload as { ok?: boolean }).ok).toBe(false);
    expect((second.payload as { code?: string }).code).toBe('invalid_request');
    expect(calls).toBe(1);
  });

  it('U4. user_question rate limit → rate_limited resp, connection survives', async () => {
    const { canProcessIpcFile } =
      await import('@core/runtime/ipc-rate-limit.js');
    for (let i = 0; i < 300; i += 1) canProcessIpcFile(FOLDER, 'user-question');

    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'userq-rl',
      answers: {},
    }));
    const handle = await startServer(buildDeps({ requestUserAnswer } as never));
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    client.sendReq(
      'user_question',
      buildUserQuestionPayload(auth.authToken, auth.responseKeyId, {
        requestId: 'userq-rl',
        threadId: THREAD_ID,
        targetJid: CHAT_JID,
      }),
      'req-userq-rl',
    );

    const resp = await client.waitForId('req-userq-rl');
    expect(resp.type).toBe('resp');
    expect((resp.payload as { ok?: boolean }).ok).toBe(false);
    expect((resp.payload as { code?: string }).code).toBe('rate_limited');
    expect(requestUserAnswer).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Message dispatch (Pillar 1, Phase 5.3b) — fire-and-forget, no resp frame.
//
// The server already dispatches `message`; this proves the folder-owns-JID
// authz + deps.sendMessage delivery over the socket, and that a frame whose
// chatJid is NOT owned by the folder is dropped (no send, no response).
// ---------------------------------------------------------------------------

describe('ipc-socket-server message dispatch', () => {
  async function handshake(
    handle: IpcSocketServerHandle,
    auth: ReturnType<typeof makeAuth>,
    threadId = THREAD_ID,
  ): Promise<FakeWorkerClient> {
    const client = await connect(handle);
    client.sendHello(
      buildHelloPayload(auth.authToken, { folder: FOLDER, threadId }),
      'hs',
    );
    const welcome = await client.waitForId('hs');
    expect(welcome.ctrl).toBe('welcome');
    return client;
  }

  async function waitForCall(
    fn: ReturnType<typeof vi.fn>,
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fn.mock.calls.length > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out waiting for sendMessage');
  }

  it('MSG1. message frame → deps.sendMessage fires (folder owns the JID)', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const handle = await startServer(buildDeps({ sendMessage } as never));
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    client.sendReq(
      'message',
      buildMessagePayload(auth.authToken, {
        text: 'live progress update',
        chatJid: CHAT_JID,
        threadId: THREAD_ID,
      }),
      'req-msg-1',
    );

    await waitForCall(sendMessage);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jidArg, textArg] = sendMessage.mock.calls[0];
    expect(jidArg).toBe(CHAT_JID);
    expect(textArg).toBe('live progress update');
    // Fire-and-forget: the connection stays open, no resp frame is required.
    expect(client.isClosed).toBe(false);
  });

  it('MSG2. message frame for a JID the folder does not own is dropped', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const handle = await startServer(buildDeps({ sendMessage } as never));
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = await handshake(handle, auth);

    // chatJid not present in conversationRoutes → folder-owns-JID authz drops it.
    client.sendReq(
      'message',
      buildMessagePayload(auth.authToken, {
        text: 'cross-conversation bleed',
        chatJid: 'wa:9999999@evil',
        threadId: THREAD_ID,
      }),
      'req-msg-evil',
    );

    // Give the server a beat to process (and drop) the frame.
    await new Promise((r) => setTimeout(r, 200));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Browser dispatch (Pillar 1, Phase 5.3c)
//
// processBrowserIpcRequest is mocked (no Chrome/CDP); writeBrowserIpcResponse is
// REAL, so the server's dispatchBrowser → registerIpcResponder →
// writeBrowserIpcResponse → signed-resp-frame path runs end to end. The browser
// channel keeps its OWN chat-scoped HMAC token + replay scope, re-verified here
// by the real parseBrowserIpcRequest exactly as the fs watcher does. The browser
// grant (registerBrowserIpcAuthorization) is keyed by (folder, chatJid, thread).
// ---------------------------------------------------------------------------

describe('ipc-socket-server browser dispatch', () => {
  async function handshake(
    handle: IpcSocketServerHandle,
    auth: ReturnType<typeof makeAuth>,
    threadId = THREAD_ID,
  ): Promise<FakeWorkerClient> {
    const client = await connect(handle);
    client.sendHello(
      buildHelloPayload(auth.authToken, { folder: FOLDER, threadId }),
      'hs',
    );
    const welcome = await client.waitForId('hs');
    expect(welcome.ctrl).toBe('welcome');
    return client;
  }

  function grantBrowser(threadId = THREAD_ID): () => void {
    registerBrowserIpcAuthorization({
      workspaceKey: FOLDER,
      chatJid: CHAT_JID,
      threadId,
    });
    return () =>
      revokeBrowserIpcAuthorization({
        workspaceKey: FOLDER,
        chatJid: CHAT_JID,
        threadId,
      });
  }

  it('B1. browser req → signed resp frame (router + ed25519 end to end)', async () => {
    processBrowserIpcRequestMock.mockResolvedValue({
      ok: true,
      data: { content: 'navigated' },
    });
    const revoke = grantBrowser();
    try {
      const handle = await startServer(buildDeps());
      const auth = makeAuth(FOLDER, THREAD_ID);
      const browserToken = browserAuthToken(FOLDER, CHAT_JID, THREAD_ID);
      const client = await handshake(handle, auth);

      client.sendReq(
        'browser',
        buildBrowserPayload(browserToken, auth.responseKeyId, {
          requestId: 'browser-7',
          action: 'navigate',
          threadId: THREAD_ID,
        }),
        'req-browser-7',
      );

      const resp = await client.waitForId('req-browser-7');
      expect(resp.type).toBe('resp');
      expect(resp.channel).toBe('browser');
      const { signature, ...payloadWithoutSig } = resp.payload as {
        signature?: string;
      } & Record<string, unknown>;
      expect(typeof signature).toBe('string');
      expect(
        verifyIpcResponsePayload(
          auth.responseVerifyKey,
          payloadWithoutSig,
          signature,
        ),
      ).toBe(true);
      expect(payloadWithoutSig.ok).toBe(true);
      expect(payloadWithoutSig.requestId).toBe('browser-7');
      expect(payloadWithoutSig.data).toEqual({ content: 'navigated' });

      // The handler ran exactly once, with the trusted parsed request + the
      // resolved browser grant (authorized=true since we registered it).
      expect(processBrowserIpcRequestMock).toHaveBeenCalledTimes(1);
      const [reqArg, ctxArg] = processBrowserIpcRequestMock.mock.calls[0];
      expect(reqArg).toEqual(
        expect.objectContaining({ requestId: 'browser-7', action: 'navigate' }),
      );
      expect(ctxArg).toEqual(
        expect.objectContaining({
          sourceAgentFolder: FOLDER,
          browserIpcAuthorized: true,
        }),
      );

      // No browser-responses file was written — the responder consumed it.
      const responsesDir = path.join(
        process.env.GANTRY_HOME as string,
        'data',
        'ipc',
        FOLDER,
        'browser-responses',
      );
      expect(fs.existsSync(path.join(responsesDir, 'browser-7.json'))).toBe(
        false,
      );
    } finally {
      revoke();
    }
  });

  it('B2. forged browser req (wrong token) → invalid_request, connection survives', async () => {
    processBrowserIpcRequestMock.mockResolvedValue({
      ok: true,
      data: { content: 'ok' },
    });
    const revoke = grantBrowser();
    try {
      const handle = await startServer(buildDeps());
      const auth = makeAuth(FOLDER, THREAD_ID);
      const client = await handshake(handle, auth);

      // Sign with a browser token bound to a DIFFERENT folder → signature
      // mismatch → parseBrowserIpcRequest throws → invalid_request.
      const wrongToken = browserAuthToken('group-evil', CHAT_JID, THREAD_ID);
      client.sendReq(
        'browser',
        buildBrowserPayload(wrongToken, auth.responseKeyId, {
          requestId: 'browser-bad',
          threadId: THREAD_ID,
        }),
        'req-browser-bad',
      );

      const resp = await client.waitForId('req-browser-bad');
      expect(resp.type).toBe('resp');
      expect((resp.payload as { ok?: boolean }).ok).toBe(false);
      expect((resp.payload as { code?: string }).code).toBe('invalid_request');
      expect(processBrowserIpcRequestMock).not.toHaveBeenCalled();
      expect(client.isClosed).toBe(false);

      // Connection still usable: a valid browser req now gets a signed response.
      const browserToken = browserAuthToken(FOLDER, CHAT_JID, THREAD_ID);
      client.sendReq(
        'browser',
        buildBrowserPayload(browserToken, auth.responseKeyId, {
          requestId: 'browser-ok',
          threadId: THREAD_ID,
        }),
        'req-browser-ok',
      );
      const ok = await client.waitForId('req-browser-ok');
      expect(ok.channel).toBe('browser');
      expect((ok.payload as { ok?: boolean }).ok).toBe(true);
    } finally {
      revoke();
    }
  });

  it('B3. replay of the same browser req is rejected the second time', async () => {
    let calls = 0;
    processBrowserIpcRequestMock.mockImplementation(async () => {
      calls += 1;
      return { ok: true, data: { content: 'first' } };
    });
    const revoke = grantBrowser();
    try {
      const handle = await startServer(buildDeps());
      const auth = makeAuth(FOLDER, THREAD_ID);
      const browserToken = browserAuthToken(FOLDER, CHAT_JID, THREAD_ID);
      const client = await handshake(handle, auth);

      const payload = buildBrowserPayload(browserToken, auth.responseKeyId, {
        requestId: 'browser-replay',
        threadId: THREAD_ID,
      });

      client.sendReq('browser', payload, 'req-first');
      const first = await client.waitForId('req-first');
      expect((first.payload as { ok?: boolean }).ok).toBe(true);

      // Re-send the byte-identical signed payload → the browser replay guard
      // (requestId already consumed) rejects it.
      client.sendReq('browser', payload, 'req-second');
      const second = await client.waitForId('req-second');
      expect((second.payload as { ok?: boolean }).ok).toBe(false);
      expect((second.payload as { code?: string }).code).toBe(
        'invalid_request',
      );
      expect(calls).toBe(1);
    } finally {
      revoke();
    }
  });

  it('B4. authorized browser rate limit → rate_limited resp, connection survives', async () => {
    processBrowserIpcRequestMock.mockResolvedValue({ ok: true, data: {} });
    const { canProcessIpcFile } =
      await import('@core/runtime/ipc-rate-limit.js');
    for (let i = 0; i < 300; i += 1) canProcessIpcFile(FOLDER, 'browser');

    const revoke = grantBrowser();
    try {
      const handle = await startServer(buildDeps());
      const auth = makeAuth(FOLDER, THREAD_ID);
      const browserToken = browserAuthToken(FOLDER, CHAT_JID, THREAD_ID);
      const client = await handshake(handle, auth);

      client.sendReq(
        'browser',
        buildBrowserPayload(browserToken, auth.responseKeyId, {
          requestId: 'browser-rl',
          threadId: THREAD_ID,
        }),
        'req-browser-rl',
      );

      const resp = await client.waitForId('req-browser-rl');
      expect(resp.type).toBe('resp');
      expect((resp.payload as { ok?: boolean }).ok).toBe(false);
      expect((resp.payload as { code?: string }).code).toBe('rate_limited');
      expect(processBrowserIpcRequestMock).not.toHaveBeenCalled();
      expect(client.isClosed).toBe(false);
    } finally {
      revoke();
    }
  });

  it('B5. the 5th concurrent browser req hits the shared cap-4 → signed {ok:false}, connection survives', async () => {
    // Gate every browser handler call on a release we control, so we can hold 4
    // in flight and watch the 5th hit the shared cap. The 5th request's signed
    // failure response is delivered to its responder (mirroring the fs watcher's
    // concurrency-limit path) without ever reaching the (still-blocked) handler.
    const releases: Array<() => void> = [];
    let started = 0;
    processBrowserIpcRequestMock.mockImplementation(async () => {
      started += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true, data: { content: 'done' } };
    });

    const revoke = grantBrowser();
    try {
      const handle = await startServer(buildDeps());
      const auth = makeAuth(FOLDER, THREAD_ID);
      const browserToken = browserAuthToken(FOLDER, CHAT_JID, THREAD_ID);
      const client = await handshake(handle, auth);

      // Fire 4 requests that acquire the whole cap and block in the handler.
      for (let i = 0; i < 4; i += 1) {
        client.sendReq(
          'browser',
          buildBrowserPayload(browserToken, auth.responseKeyId, {
            requestId: `browser-hold-${i}`,
            threadId: THREAD_ID,
          }),
          `req-hold-${i}`,
        );
      }
      // Wait until all 4 are actually inside the (blocked) handler.
      const deadline = Date.now() + 3000;
      while (started < 4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(started).toBe(4);

      // The 5th request hits the shared cap: it gets a signed {ok:false} resp
      // and never reaches the handler.
      client.sendReq(
        'browser',
        buildBrowserPayload(browserToken, auth.responseKeyId, {
          requestId: 'browser-over-cap',
          threadId: THREAD_ID,
        }),
        'req-over-cap',
      );
      const capped = await client.waitForId('req-over-cap');
      expect(capped.type).toBe('resp');
      expect(capped.channel).toBe('browser');
      // Signed failure response (router-delivered) — the verified payload says
      // ok:false, exactly as the fs watcher's writeBrowserFailureResponse emits.
      const { signature, ...cappedPayload } = capped.payload as {
        signature?: string;
      } & Record<string, unknown>;
      expect(typeof signature).toBe('string');
      expect(
        verifyIpcResponsePayload(
          auth.responseVerifyKey,
          cappedPayload,
          signature,
        ),
      ).toBe(true);
      expect(cappedPayload.ok).toBe(false);
      expect(cappedPayload.requestId).toBe('browser-over-cap');
      expect(started).toBe(4); // handler never ran for the 5th
      expect(client.isClosed).toBe(false);

      // Drain the 4 held handlers so their responses settle and the cap frees.
      for (const release of releases.splice(0)) release();
      for (let i = 0; i < 4; i += 1) {
        const ok = await client.waitForId(`req-hold-${i}`);
        expect((ok.payload as { ok?: boolean }).ok).toBe(true);
      }
    } finally {
      for (const release of releases.splice(0)) release();
      revoke();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Bad/malformed frame → connection closes, server survives
// ---------------------------------------------------------------------------

describe('ipc-socket-server resilience', () => {
  it('8. a malformed wire frame closes that connection but the server survives', async () => {
    const handle = await startServer(buildDeps());
    const bad = await connect(handle);
    // Frame header says 5 bytes, body is invalid JSON "{{{{{".
    const body = Buffer.from('{{{{{', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    bad.sendBytes(Buffer.concat([header, body]));

    await bad.waitClose();
    expect(bad.isClosed).toBe(true);

    // A SECOND client can still connect and complete the handshake.
    const good = await connect(handle);
    const auth = makeAuth(FOLDER, THREAD_ID);
    good.sendHello(
      buildHelloPayload(auth.authToken, {
        folder: FOLDER,
        threadId: THREAD_ID,
      }),
      'hs2',
    );
    const welcome = await good.waitForId('hs2');
    expect(welcome.ctrl).toBe('welcome');
  });
});

// ---------------------------------------------------------------------------
// 9. Single-instance election + clean shutdown
// ---------------------------------------------------------------------------

describe('ipc-socket-server single-instance', () => {
  it('9. a second start on the same socket returns undefined; cleanup leaves no files', async () => {
    const deps = buildDeps();
    const first = await startServer(deps);

    const second = await startIpcSocketServer(deps, {
      socketPath: socketPathFor(),
    });
    expect(second).toBeUndefined();

    // Stop the live owner → socket + owner files are removed.
    await first.stop();
    server = undefined;
    expect(fs.existsSync(socketPathFor())).toBe(false);
    expect(fs.existsSync(`${socketPathFor()}.owner`)).toBe(false);
  });
});
