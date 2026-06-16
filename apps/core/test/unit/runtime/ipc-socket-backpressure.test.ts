import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// processTaskIpc is mocked so the test controls EXACTLY what the task handler
// does (it normally fans out to the real scheduler/admin handlers). For the
// in-flight cap + fairness cases the mock blocks on a release we control, so we
// can hold N requests in flight and watch the cap / fairness behaviour. In the
// soak case it resolves immediately via the REAL writeTaskIpcResponse, so the
// response-router → signed-resp-frame → responder-consumed path runs end to end
// (proving no responder leak after the run).
vi.mock('@core/jobs/ipc-handler.js', () => ({
  processTaskIpc: vi.fn(),
}));

import { processTaskIpc } from '@core/jobs/ipc-handler.js';
import { writeTaskIpcResponse } from '@core/jobs/ipc-shared.js';
import {
  computeIpcAuthToken,
  createIpcAuthEnvelope,
} from '@core/runtime/ipc-auth.js';
import {
  startIpcSocketServer,
  type IpcSocketServerHandle,
} from '@core/runtime/ipc-socket-server.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { createSignedIpcRequestEnvelope } from '@core/runner/mcp/signing.js';
import { encodeFrame, FrameDecoder } from '@core/shared/ipc-frame.js';
import {
  encodeWireFrame,
  parseWireFrame,
  type IpcWireFrame,
  type IpcWireChannel,
} from '@core/shared/ipc-wire.js';
import {
  clearIpcResponders,
  hasIpcResponder,
} from '@core/runtime/ipc-response-router.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import {
  canProcessIpcFile,
  clearIpcRateLimitState,
} from '@core/runtime/ipc-rate-limit.js';
import { clearInteractionInFlight } from '@core/runtime/ipc-interaction-inflight.js';

const processTaskIpcMock = vi.mocked(processTaskIpc);

// ---------------------------------------------------------------------------
// Fixtures — two folders/conversations so the fairness + cross-connection
// cases can drive independent connections that survive each other's load.
// ---------------------------------------------------------------------------

const FOLDER_A = 'group-a';
const FOLDER_B = 'group-b';
const CHAT_JID_A = 'wa:1555000@test';
const CHAT_JID_B = 'wa:1555111@test';
const THREAD_ID = 'thread-abc';

const RATE_LIMIT_MAX = 300; // mirrors IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW

function buildDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  const routes: Record<string, ConversationRoute> = {
    [CHAT_JID_A]: {
      name: 'Group A',
      folder: FOLDER_A,
      trigger: '',
      added_at: new Date().toISOString(),
    },
    [CHAT_JID_B]: {
      name: 'Group B',
      folder: FOLDER_B,
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
// frame reads. (Mirrors the harness in ipc-socket-transport.test.ts so the
// server is exercised over a REAL socket, not an in-process shim.)
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

  /**
   * Collect EVERY frame (resp + ctrl) bearing `id` until `count` are seen.
   * The backpressure path sends BOTH a `resp{busy}` and a `ctrl:busy` under the
   * same frame id, so a single request id can yield two frames.
   */
  async collectById(
    id: string,
    count: number,
    timeoutMs = 5000,
  ): Promise<IpcWireFrame[]> {
    const out: IpcWireFrame[] = [];
    const deadline = Date.now() + timeoutMs;
    while (out.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `collectById(${id}) timeout — saw ${out.length}/${count}`,
        );
      }
      const frame = await this.nextFrame(remaining);
      if (frame.id === id) out.push(frame);
    }
    return out;
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
  },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(authToken, {
    kind: 'hello',
    role: opts.role ?? 'mcp',
    runHandle: opts.runHandle ?? 'run-1',
    folder: opts.folder,
    context: { threadId: opts.threadId ?? null },
  });
}

function buildTaskPayload(
  authToken: string,
  responseKeyId: string,
  opts: { taskId: string; type?: string; threadId?: string },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(authToken, {
    type: opts.type ?? 'scheduler_list_jobs',
    taskId: opts.taskId,
    context: {
      threadId: opts.threadId ?? null,
      responseKeyId,
    },
  });
}

function buildPermissionPayload(
  responseKeyId: string,
  opts: {
    requestId: string;
    folder?: string;
    threadId?: string;
    targetJid?: string;
    appId?: string;
    responseNonce?: string;
    jobId?: string;
    runId?: string;
  },
): Record<string, unknown> {
  const appId = opts.appId ?? 'default';
  const folder = opts.folder ?? FOLDER_A;
  const token = computeIpcAuthToken(folder, opts.threadId, { appId });
  return createSignedIpcRequestEnvelope(token, {
    requestId: opts.requestId,
    appId,
    responseNonce: opts.responseNonce ?? `${opts.requestId}-nonce`,
    sourceAgentFolder: folder,
    ...(opts.targetJid !== undefined ? { targetJid: opts.targetJid } : {}),
    ...(opts.jobId ? { jobId: opts.jobId } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    context: {
      appId,
      ...(opts.targetJid !== undefined ? { chatJid: opts.targetJid } : {}),
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-socket-backpressure-'));
  processTaskIpcMock.mockReset();
  clearIpcResponders();
  clearConsumedIpcRequestIds();
  clearIpcRateLimitState();
  clearInteractionInFlight();
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
  clearInteractionInFlight();
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

async function handshake(
  handle: IpcSocketServerHandle,
  auth: ReturnType<typeof makeAuth>,
  opts: { folder: string; role?: 'runner' | 'mcp'; threadId?: string } = {
    folder: FOLDER_A,
  },
): Promise<FakeWorkerClient> {
  const client = await connect(handle);
  const id = `hs-${Math.random().toString(36).slice(2)}`;
  client.sendHello(
    buildHelloPayload(auth.authToken, {
      folder: opts.folder,
      role: opts.role,
      threadId: opts.threadId ?? THREAD_ID,
    }),
    id,
  );
  const welcome = await client.waitForId(id);
  expect(welcome.ctrl).toBe('welcome');
  return client;
}

/**
 * The mocked task handler does NOT receive the connection's folder (the parsed
 * TaskIpcData carries no sourceAgentFolder — the real server passes the folder
 * separately when registering the responder). We therefore route the test
 * response back to the SAME folder the server registered the responder under by
 * deriving it from the taskId prefix we control. `other-*` belongs to FOLDER_B;
 * everything else to FOLDER_A.
 */
function folderForTaskId(taskId: string | undefined): string {
  return taskId && taskId.startsWith('other-') ? FOLDER_B : FOLDER_A;
}

/** A handler that blocks until released — gates in-flight slots open. */
function makeGatedHandler(): {
  release: () => void;
  startedCount: () => number;
  waitStarted: (n: number, timeoutMs?: number) => Promise<void>;
} {
  const releases: Array<() => void> = [];
  let started = 0;
  processTaskIpcMock.mockImplementation(async (data) => {
    started += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    // After release, settle with a real signed response so the client's
    // pending request resolves and the responder is consumed.
    writeTaskIpcResponse(
      folderForTaskId(data.taskId),
      data.taskId,
      { ok: true, message: 'released' },
      data.authThreadId,
      data.responseKeyId,
    );
  });
  return {
    release: () => {
      for (const r of releases.splice(0)) r();
    },
    startedCount: () => started,
    waitStarted: async (n, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (started < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      if (started < n) {
        throw new Error(`only ${started}/${n} handlers started`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. In-flight cap honored: cap holds at maxInFlightPerConnection, the
//    over-cap request gets a `busy` transport error + a `ctrl:busy` frame, and
//    after release the held requests settle (cap recovers).  [spec edge-case 25]
// ---------------------------------------------------------------------------

describe('ipc-socket-backpressure: in-flight cap', () => {
  it('1. holds the per-connection cap, busies the over-cap req (resp+ctrl:busy), then recovers', async () => {
    const gate = makeGatedHandler();
    const handle = await startServer(buildDeps(), {
      maxInFlightPerConnection: 4,
    });
    const auth = makeAuth(FOLDER_A, THREAD_ID);
    const client = await handshake(handle, auth);

    // Fire 4 concurrent task reqs — each acquires a slot and blocks in handler.
    for (let i = 0; i < 4; i += 1) {
      client.sendReq(
        'task',
        buildTaskPayload(auth.authToken, auth.responseKeyId, {
          taskId: `hold-${i}`,
          threadId: THREAD_ID,
        }),
        `req-hold-${i}`,
      );
    }
    await gate.waitStarted(4);
    expect(gate.startedCount()).toBe(4);

    // The 5th req exceeds the cap. The server signals backpressure with BOTH a
    // resp{ok:false, busy} AND a ctrl:busy frame (D6 — explicit busy), under the
    // SAME frame id, and does NOT grow in-flight (handler never runs for it).
    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'over-cap',
        threadId: THREAD_ID,
      }),
      'req-over-cap',
    );

    const frames = await client.collectById('req-over-cap', 2);
    const resp = frames.find((f) => f.type === 'resp');
    const busyCtrl = frames.find((f) => f.type === 'ctrl');
    expect(resp).toBeDefined();
    expect((resp!.payload as { ok?: boolean }).ok).toBe(false);
    expect((resp!.payload as { code?: string }).code).toBe('busy');
    expect(busyCtrl).toBeDefined();
    expect(busyCtrl!.ctrl).toBe('busy');

    // The cap held: the handler ran only for the 4 admitted reqs, not the 5th.
    expect(gate.startedCount()).toBe(4);
    expect(client.isClosed).toBe(false);
    // No responder was registered for the rejected req (it never reached
    // dispatchTask): the registry holds exactly the 4 held requests' keys.
    expect(hasIpcResponder(FOLDER_A, 'task-over-cap')).toBe(false);
    for (let i = 0; i < 4; i += 1) {
      expect(hasIpcResponder(FOLDER_A, `task-hold-${i}`)).toBe(true);
    }

    // Release the 4 held handlers → they settle and the cap recovers.
    gate.release();
    for (let i = 0; i < 4; i += 1) {
      const ok = await client.waitForId(`req-hold-${i}`);
      expect((ok.payload as { ok?: boolean }).ok).toBe(true);
    }
    // All 4 responders consumed by the write chokepoint → none leaked.
    for (let i = 0; i < 4; i += 1) {
      expect(hasIpcResponder(FOLDER_A, `task-hold-${i}`)).toBe(false);
    }

    // Recovery proof: with the 4 slots freed, a fresh req is admitted again.
    // Swap to an immediately-resolving handler so this request is not gated on
    // the (now drained) release queue.
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER_A,
        data.taskId,
        { ok: true, message: 'recovered' },
        data.authThreadId,
        data.responseKeyId,
      );
    });
    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'after-recover',
        threadId: THREAD_ID,
      }),
      'req-after-recover',
    );
    const recovered = await client.waitForId('req-after-recover');
    expect((recovered.payload as { ok?: boolean }).ok).toBe(true);
  });

  it('1b. reserves a permission in-flight slot before scheduled-job validation awaits', async () => {
    const releases: Array<() => void> = [];
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      mode: 'allow_once' as const,
    }));
    const opsRepository = {
      getJobById: vi.fn(
        async () =>
          new Promise((resolve) => {
            releases.push(() =>
              resolve({
                id: 'job-1',
                group_scope: FOLDER_A,
                execution_context: {
                  conversationJid: CHAT_JID_A,
                  groupScope: FOLDER_A,
                  threadId: THREAD_ID,
                },
              }),
            );
          }),
      ),
      getJobRunById: vi.fn(async () => ({ id: 'run-1', job_id: 'job-1' })),
    };
    const handle = await startServer(
      buildDeps({ requestPermissionApproval, opsRepository } as never),
      { maxInFlightPerConnection: 1 },
    );
    const auth = makeAuth(FOLDER_A, THREAD_ID);
    const client = await handshake(handle, auth, {
      folder: FOLDER_A,
      role: 'runner',
    });

    try {
      client.sendReq(
        'permission',
        buildPermissionPayload(auth.responseKeyId, {
          requestId: 'perm-held',
          threadId: THREAD_ID,
          targetJid: CHAT_JID_A,
          jobId: 'job-1',
          runId: 'run-1',
        }),
        'req-perm-held',
      );

      await vi.waitFor(() => {
        expect(opsRepository.getJobById).toHaveBeenCalledTimes(1);
      });

      client.sendReq(
        'permission',
        buildPermissionPayload(auth.responseKeyId, {
          requestId: 'perm-over-cap',
          threadId: THREAD_ID,
          targetJid: CHAT_JID_A,
          jobId: 'job-1',
          runId: 'run-1',
        }),
        'req-perm-over-cap',
      );

      const busy = await client_collectBusy(client, 'req-perm-over-cap');
      expect(busy.code).toBe('busy');
      expect(opsRepository.getJobById).toHaveBeenCalledTimes(1);
      expect(requestPermissionApproval).not.toHaveBeenCalled();

      for (const release of releases.splice(0)) release();
      const held = await client.waitForId('req-perm-held');
      expect((held.payload as { approved?: boolean }).approved).toBe(true);
      expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    } finally {
      for (const release of releases.splice(0)) release();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No starvation across connections (fairness hook): one connection pinned at
//    its cap (all slots held) does NOT block a second connection's requests —
//    the cap is PER CONNECTION, so the second connection makes progress.
//    [spec edge-case 25: "no starvation across connections (fairness hook)"]
// ---------------------------------------------------------------------------

describe('ipc-socket-backpressure: fairness across connections', () => {
  it('2. a connection pinned at its cap does not starve another connection', async () => {
    const gate = makeGatedHandler();
    const handle = await startServer(buildDeps(), {
      maxInFlightPerConnection: 2,
    });

    // Connection A (folder A) — fill its 2 slots and pin it at the cap.
    const authA = makeAuth(FOLDER_A, THREAD_ID);
    const chatty = await handshake(handle, authA, { folder: FOLDER_A });
    for (let i = 0; i < 2; i += 1) {
      chatty.sendReq(
        'task',
        buildTaskPayload(authA.authToken, authA.responseKeyId, {
          taskId: `chatty-${i}`,
          threadId: THREAD_ID,
        }),
        `req-chatty-${i}`,
      );
    }
    await gate.waitStarted(2);

    // A 3rd req on the chatty connection is over its cap → busy (it is shed, not
    // queued unboundedly), but this must NOT affect the other connection.
    chatty.sendReq(
      'task',
      buildTaskPayload(authA.authToken, authA.responseKeyId, {
        taskId: 'chatty-over',
        threadId: THREAD_ID,
      }),
      'req-chatty-over',
    );
    const chattyBusy = await client_collectBusy(chatty, 'req-chatty-over');
    expect(chattyBusy.code).toBe('busy');

    // Connection B (folder B) fires its OWN requests. They must be serviced even
    // while A is pinned at its cap with the (still-blocked) handler holding both
    // its slots — the only thing gating B's handler is the shared gate release.
    const authB = makeAuth(FOLDER_B, THREAD_ID);
    const other = await handshake(handle, authB, { folder: FOLDER_B });
    for (let i = 0; i < 2; i += 1) {
      other.sendReq(
        'task',
        buildTaskPayload(authB.authToken, authB.responseKeyId, {
          taskId: `other-${i}`,
          threadId: THREAD_ID,
        }),
        `req-other-${i}`,
      );
    }
    // B's two handlers START (proving B is admitted, not head-of-line blocked by
    // A's pinned slots) — total started becomes 4 (2 from A + 2 from B).
    await gate.waitStarted(4);
    expect(gate.startedCount()).toBe(4);

    // Release everything → BOTH connections' requests settle (both progress).
    gate.release();
    for (let i = 0; i < 2; i += 1) {
      const okA = await chatty.waitForId(`req-chatty-${i}`);
      expect((okA.payload as { ok?: boolean }).ok).toBe(true);
      const okB = await other.waitForId(`req-other-${i}`);
      expect((okB.payload as { ok?: boolean }).ok).toBe(true);
    }
    expect(chatty.isClosed).toBe(false);
    expect(other.isClosed).toBe(false);
  });
});

/** Helper: collect the resp{busy} for a backpressured req id and return it. */
async function client_collectBusy(
  client: FakeWorkerClient,
  id: string,
): Promise<{ ok?: boolean; code?: string }> {
  const frames = await client.collectById(id, 2);
  const resp = frames.find((f) => f.type === 'resp');
  expect(resp).toBeDefined();
  expect(frames.some((f) => f.type === 'ctrl' && f.ctrl === 'busy')).toBe(true);
  return resp!.payload as { ok?: boolean; code?: string };
}

// ---------------------------------------------------------------------------
// 3. Rate limit 300/60s honored on the socket path.  [spec edge-case 26]
//    Exhaust the (folder,'tasks') limiter programmatically (299) so the next
//    SOCKET req consumes token 300 and succeeds, and the one after that trips
//    `rate_limited`; the connection survives.
// ---------------------------------------------------------------------------

describe('ipc-socket-backpressure: rate limit', () => {
  it('3. trips rate_limited once 300/60s is exhausted; connection survives', async () => {
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER_A,
        data.taskId,
        { ok: true, message: 'ok' },
        data.authThreadId,
        data.responseKeyId,
      );
    });

    // Pre-consume 299 tokens so the limiter is one shy of the cap.
    for (let i = 0; i < RATE_LIMIT_MAX - 1; i += 1) {
      expect(canProcessIpcFile(FOLDER_A, 'tasks')).toBe(true);
    }

    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER_A, THREAD_ID);
    const client = await handshake(handle, auth);

    // Token #300 — the last allowed in the window → succeeds over the socket.
    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'rl-last-ok',
        threadId: THREAD_ID,
      }),
      'req-rl-last-ok',
    );
    const okResp = await client.waitForId('req-rl-last-ok');
    expect((okResp.payload as { ok?: boolean }).ok).toBe(true);

    // The next req is over the limit → rate_limited (checked BEFORE parse, so
    // the handler never runs for it).
    const callsBefore = processTaskIpcMock.mock.calls.length;
    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'rl-over',
        threadId: THREAD_ID,
      }),
      'req-rl-over',
    );
    const limited = await client.waitForId('req-rl-over');
    expect(limited.type).toBe('resp');
    expect((limited.payload as { ok?: boolean }).ok).toBe(false);
    expect((limited.payload as { code?: string }).code).toBe('rate_limited');
    // The rate-limited req never reached the handler.
    expect(processTaskIpcMock.mock.calls.length).toBe(callsBefore);
    expect(client.isClosed).toBe(false);

    // A second over-limit req still trips (state is sticky within the window).
    client.sendReq(
      'task',
      buildTaskPayload(auth.authToken, auth.responseKeyId, {
        taskId: 'rl-over-2',
        threadId: THREAD_ID,
      }),
      'req-rl-over-2',
    );
    const limited2 = await client.waitForId('req-rl-over-2');
    expect((limited2.payload as { code?: string }).code).toBe('rate_limited');
    expect(client.isClosed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Bad frames vs the authorized bucket.  [spec edge-case 26:
//    "bad frames don't charge the authorized bucket (current behavior
//    preserved)" — note the qualifier "authorized bucket": that is the
//    CONDITIONAL browser charge. For the TASK channel, the socket path charges
//    BEFORE parse, so a bad task payload DOES consume a token. We assert that
//    behavior (the release gate),
//    plus the key invariant: a flood of bad frames neither crashes the server
//    nor starves a concurrent VALID request on another connection.]
//
//    Two distinct kinds of "bad frame":
//      (a) malformed WIRE frame (bad JSON / bad shape) — rejected per frame at
//          the wire layer BEFORE dispatch, so the connection survives and no
//          authorized bucket is charged.
//      (b) structurally-valid wire frame whose TASK PAYLOAD fails
//          parseTaskIpcData (forged HMAC) — survives the wire layer, reaches
//          dispatchTask, gets an `invalid_request` resp, the connection SURVIVES,
//          and it charges the (folder,'tasks') bucket (charge-before-parse).
// ---------------------------------------------------------------------------

describe('ipc-socket-backpressure: bad frames vs authorized bucket', () => {
  it('4a. a flood of malformed-wire frames is rejected per-frame; the connection, server, and authorized buckets survive', async () => {
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER_B,
        data.taskId,
        { ok: true, message: 'survivor' },
        data.authThreadId,
        data.responseKeyId,
      );
    });
    const handle = await startServer(buildDeps());

    // A healthy connection on folder B that we will keep using throughout.
    const authB = makeAuth(FOLDER_B, THREAD_ID);
    const survivor = await handshake(handle, authB, { folder: FOLDER_B });

    // Flood: one authorized folder-A connection sends 12 malformed full wire
    // frames. Each is rejected before dispatch; the connection is not destroyed
    // and no channel-specific bucket is charged.
    const authA = makeAuth(FOLDER_A, THREAD_ID);
    const attacker = await handshake(handle, authA, { folder: FOLDER_A });
    const floodCount = 12;
    for (let i = 0; i < floodCount; i += 1) {
      const body = Buffer.from('{not-json' + i, 'utf8');
      attacker.sendBytes(encodeFrame(body));
    }

    // The attacker connection is still usable after the malformed frames.
    attacker.sendReq(
      'continuation',
      buildTaskPayload(authA.authToken, authA.responseKeyId, {
        taskId: 'unsupported-after-malformed',
        threadId: THREAD_ID,
      }),
      'req-unsupported-after-malformed',
    );
    const unsupported = await attacker.waitForId(
      'req-unsupported-after-malformed',
    );
    expect((unsupported.payload as { code?: string }).code).toBe(
      'unsupported_channel',
    );
    expect(attacker.isClosed).toBe(false);

    // The server survived the flood: the healthy connection still services a
    // valid request end to end.
    survivor.sendReq(
      'task',
      buildTaskPayload(authB.authToken, authB.responseKeyId, {
        taskId: 'survivor-1',
        threadId: THREAD_ID,
      }),
      'req-survivor-1',
    );
    const ok = await survivor.waitForId('req-survivor-1');
    expect((ok.payload as { ok?: boolean }).ok).toBe(true);
    expect(survivor.isClosed).toBe(false);

    // And a brand-new connection can still handshake after the flood.
    const fresh = await handshake(handle, makeAuth(FOLDER_A, THREAD_ID), {
      folder: FOLDER_A,
    });
    expect(fresh.isClosed).toBe(false);

    // Malformed wire frames never reached dispatchTask, so the folder-A task
    // bucket still has its full allowance available.
    let remaining = 0;
    while (canProcessIpcFile(FOLDER_A, 'tasks')) remaining += 1;
    expect(remaining).toBe(RATE_LIMIT_MAX);
  });

  it('4b. a flood of valid-wire/bad-payload task frames survives the connection, does not starve another connection, and charges the bucket (charge-before-parse parity with fs)', async () => {
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER_B,
        data.taskId,
        { ok: true, message: 'survivor' },
        data.authThreadId,
        data.responseKeyId,
      );
    });
    const handle = await startServer(buildDeps());

    // Attacker connection on folder A (valid handshake) that floods bad-payload
    // task frames. A forged token (different folder) makes parseTaskIpcData throw
    // inside dispatchTask — the connection survives with an invalid_request resp.
    const authA = makeAuth(FOLDER_A, THREAD_ID);
    const attacker = await handshake(handle, authA, { folder: FOLDER_A });
    const wrongAuth = makeAuth('group-evil', THREAD_ID);

    // Concurrent healthy connection on folder B (different rate bucket) — must
    // keep making progress while A is flooded with garbage.
    const authB = makeAuth(FOLDER_B, THREAD_ID);
    const survivor = await handshake(handle, authB, { folder: FOLDER_B });

    const floodCount = 20;
    for (let i = 0; i < floodCount; i += 1) {
      attacker.sendReq(
        'task',
        buildTaskPayload(wrongAuth.authToken, authA.responseKeyId, {
          taskId: `bad-${i}`,
          threadId: THREAD_ID,
        }),
        `req-bad-${i}`,
      );
    }

    // Every bad frame got an invalid_request resp; the attacker connection never
    // closed and the handler never ran for any of them.
    for (let i = 0; i < floodCount; i += 1) {
      const resp = await attacker.waitForId(`req-bad-${i}`);
      expect(resp.type).toBe('resp');
      expect((resp.payload as { ok?: boolean }).ok).toBe(false);
      expect((resp.payload as { code?: string }).code).toBe('invalid_request');
    }
    expect(attacker.isClosed).toBe(false);
    expect(processTaskIpcMock).not.toHaveBeenCalled();

    // No starvation: the other connection's valid req completed alongside.
    survivor.sendReq(
      'task',
      buildTaskPayload(authB.authToken, authB.responseKeyId, {
        taskId: 'survivor-during-flood',
        threadId: THREAD_ID,
      }),
      'req-survivor-during-flood',
    );
    const ok = await survivor.waitForId('req-survivor-during-flood');
    expect((ok.payload as { ok?: boolean }).ok).toBe(true);
    expect(survivor.isClosed).toBe(false);

    // No responder leak from the rejected frames (each dispatchTask threw at
    // parse BEFORE registering a responder).
    for (let i = 0; i < floodCount; i += 1) {
      expect(hasIpcResponder(FOLDER_A, `task-bad-${i}`)).toBe(false);
    }

    // CHARGE-BEFORE-PARSE: the socket task path calls canProcessIpcFile before
    // parseTaskIpcData. So each of the `floodCount` bad frames consumed a
    // (group-a,'tasks') token even though it never parsed. We prove that by
    // measuring how many tokens remain in this window: the limiter must now be
    // exactly `floodCount` tokens lower than a fresh bucket.
    let remaining = 0;
    while (canProcessIpcFile(FOLDER_A, 'tasks')) remaining += 1;
    // The window for (group-a,'tasks') was opened by the FIRST bad frame, so the
    // count after the flood is `floodCount`; the remaining allowance is
    // RATE_LIMIT_MAX - floodCount.
    expect(remaining).toBe(RATE_LIMIT_MAX - floodCount);
  });
});

// ---------------------------------------------------------------------------
// 5. Soak / no leak: sustained traffic over many short-lived connections
//    (connect → request → disconnect). All settle; afterwards no responder
//    leak, connections cleaned up (connectionsForFolder empty), and the in-flight
//    accounting recovered (proven via the cap: a fresh connection is admitted to
//    its full cap again — there is no public getter for the per-connection
//    counter, so we assert the observable proxies + functional recovery).
//    [spec §13.7 soak: "sustained traffic ... with no FD/memory leak
//     (connections cleaned up on drop)"]
// ---------------------------------------------------------------------------

describe('ipc-socket-backpressure: soak / no leak', () => {
  it('5. 220 task reqs across short-lived connections all settle; no responder/connection leak afterward', async () => {
    // Fast handler — resolves immediately with a real signed response so each
    // request settles and its responder is consumed by the write chokepoint.
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER_A,
        data.taskId,
        { ok: true, message: 'soak' },
        data.authThreadId,
        data.responseKeyId,
      );
    });

    const handle = await startServer(buildDeps(), {
      maxInFlightPerConnection: 8,
    });

    // 220 < 300, so we stay within ONE rate-limit window for (group-a,'tasks')
    // and the soak is not perturbed by the limiter. Run in small waves of
    // short-lived connections that connect → request → disconnect.
    const TOTAL = 220;
    const WAVE = 10;
    const taskIds: string[] = [];
    let n = 0;
    while (n < TOTAL) {
      const waveSize = Math.min(WAVE, TOTAL - n);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        Array.from({ length: waveSize }, async (_unused, j) => {
          const idx = n + j;
          const auth = makeAuth(FOLDER_A, THREAD_ID);
          const c = await FakeWorkerClient.connect(handle.socketPath);
          try {
            const hsId = `hs-${idx}`;
            c.sendHello(
              buildHelloPayload(auth.authToken, {
                folder: FOLDER_A,
                threadId: THREAD_ID,
              }),
              hsId,
            );
            await c.waitForId(hsId);
            const taskId = `soak-${idx}`;
            taskIds.push(taskId);
            c.sendReq(
              'task',
              buildTaskPayload(auth.authToken, auth.responseKeyId, {
                taskId,
                threadId: THREAD_ID,
              }),
              `req-${idx}`,
            );
            const resp = await c.waitForId(`req-${idx}`);
            expect((resp.payload as { ok?: boolean }).ok).toBe(true);
          } finally {
            // Short-lived: disconnect right after the response settles.
            c.destroy();
          }
        }),
      );
      n += waveSize;
    }

    expect(taskIds.length).toBe(TOTAL);
    expect(processTaskIpcMock.mock.calls.length).toBe(TOTAL);

    // Give the server a beat to observe all the socket closes (onClose runs on
    // the 'close' event, asynchronously to our client-side destroy()).
    const deadline = Date.now() + 3000;
    while (
      handle.connectionsForFolder(FOLDER_A).length > 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // No connection leak: every short-lived connection was cleaned from the
    // folder index on drop.
    expect(handle.connectionsForFolder(FOLDER_A).length).toBe(0);
    expect(handle.connectionsForFolder(FOLDER_B).length).toBe(0);

    // No responder leak: every request's single-shot responder was consumed
    // (by the write chokepoint) or purged (on close). The registry is empty for
    // all task keys we created.
    for (const taskId of taskIds) {
      expect(hasIpcResponder(FOLDER_A, `task-${taskId}`)).toBe(false);
    }

    // In-flight accounting recovered: a fresh connection is admitted to its FULL
    // cap again (8 concurrent held requests all start), proving no slots leaked
    // from the soak. (No public getter exists for the per-connection counter, so
    // this functional check is the strongest available assertion.)
    const gate = makeGatedHandler();
    const auth = makeAuth(FOLDER_A, THREAD_ID);
    const fresh = await handshake(handle, auth, { folder: FOLDER_A });
    for (let i = 0; i < 8; i += 1) {
      fresh.sendReq(
        'task',
        buildTaskPayload(auth.authToken, auth.responseKeyId, {
          taskId: `post-soak-${i}`,
          threadId: THREAD_ID,
        }),
        `req-post-soak-${i}`,
      );
    }
    await gate.waitStarted(8);
    expect(gate.startedCount()).toBe(8);
    gate.release();
    for (let i = 0; i < 8; i += 1) {
      const ok = await fresh.waitForId(`req-post-soak-${i}`);
      expect((ok.payload as { ok?: boolean }).ok).toBe(true);
    }
  });
});
