import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// processTaskIpc is mocked so each test controls exactly what the task handler
// does. In the success path the mock calls the REAL writeTaskIpcResponse, which
// finds the registered responder and delivers a signed resp frame end to end.
vi.mock('@core/jobs/ipc-handler.js', () => ({
  processTaskIpc: vi.fn(),
}));

import { processTaskIpc } from '@core/jobs/ipc-handler.js';
import { writeTaskIpcResponse } from '@core/jobs/ipc-shared.js';
import {
  startIpcSocketServer,
  type IpcSocketServerHandle,
} from '@core/runtime/ipc-socket-server.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { createSignedIpcRequestEnvelope } from '@core/runner/mcp/signing.js';
import { verifyIpcResponsePayload } from '@core/infrastructure/ipc/response-signing.js';
import { createIpcResponseSigningKeyPair } from '@core/infrastructure/ipc/response-signing.js';
import type { IpcWireFrame } from '@core/shared/ipc-wire.js';
import { clearIpcResponders } from '@core/runtime/ipc-response-router.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import { clearIpcRateLimitState } from '@core/runtime/ipc-rate-limit.js';

import {
  IpcSocketClient,
  IpcRequestError,
} from '@core/shared/ipc-socket-client.js';

const processTaskIpcMock = vi.mocked(processTaskIpc);

// ---------------------------------------------------------------------------
// Fixtures (mirrors ipc-socket-transport.test.ts)
// ---------------------------------------------------------------------------

const FOLDER = 'group-test';
const THREAD_ID = 'thread-abc';
const CHAT_JID = 'wa:1555000@test';

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
    role: opts.role ?? 'mcp',
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

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let server: IpcSocketServerHandle | undefined;
const clientsToClose: IpcSocketClient[] = [];

function socketPathFor(name = 'core.sock'): string {
  return path.join(tmpDir, name);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-socket-client-'));
  processTaskIpcMock.mockReset();
  clearIpcResponders();
  clearConsumedIpcRequestIds();
  clearIpcRateLimitState();
});

afterEach(async () => {
  for (const c of clientsToClose.splice(0)) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
  if (server) {
    await server.stop().catch(() => undefined);
    server = undefined;
  }
  clearIpcResponders();
  clearConsumedIpcRequestIds();
  clearIpcRateLimitState();
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

/** Build a client wired to verify resps against `auth.responseVerifyKey`. */
function makeClient(
  auth: ReturnType<typeof makeAuth>,
  overrides: Partial<{
    folder: string;
    threadId: string;
    verifyKey: string;
    reconnect: {
      enabled: boolean;
      baseDelayMs?: number;
      maxDelayMs?: number;
      replayPending?: boolean;
    };
  }> = {},
): IpcSocketClient {
  const verifyKey = overrides.verifyKey ?? auth.responseVerifyKey;
  const client = new IpcSocketClient({
    socketPath: socketPathFor(),
    buildHello: () =>
      buildHelloPayload(auth.authToken, {
        folder: overrides.folder ?? FOLDER,
        threadId: overrides.threadId ?? THREAD_ID,
      }),
    verifyResponse: (p, sig) => verifyIpcResponsePayload(verifyKey, p, sig),
    reconnect: overrides.reconnect,
  });
  clientsToClose.push(client);
  return client;
}

function respondOnce(message = 'done'): void {
  processTaskIpcMock.mockImplementation(async (data) => {
    writeTaskIpcResponse(
      FOLDER,
      data.taskId,
      { ok: true, message },
      data.authThreadId,
      data.responseKeyId,
    );
  });
}

// ---------------------------------------------------------------------------
// 1. connect + handshake
// ---------------------------------------------------------------------------

describe('IpcSocketClient handshake', () => {
  it('1. connect() resolves and reports connected', async () => {
    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = makeClient(auth);

    await client.connect();
    expect(client.connected).toBe(true);
    expect(handle.connectionsForFolder(FOLDER).length).toBe(1);
  });

  it('5. handshake failure (wrong token) rejects connect()', async () => {
    await startServer(buildDeps());
    // Sign hello with a token for a DIFFERENT folder → server rejects + closes.
    const wrongAuth = makeAuth('group-evil', THREAD_ID);
    const realAuth = makeAuth(FOLDER, THREAD_ID);
    const client = new IpcSocketClient({
      socketPath: socketPathFor(),
      buildHello: () =>
        buildHelloPayload(wrongAuth.authToken, {
          folder: FOLDER,
          threadId: THREAD_ID,
        }),
      verifyResponse: (p, sig) =>
        verifyIpcResponsePayload(realAuth.responseVerifyKey, p, sig),
    });
    clientsToClose.push(client);

    await expect(client.connect()).rejects.toBeInstanceOf(Error);
    expect(client.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2-4, 6, 8. request round-trips
// ---------------------------------------------------------------------------

describe('IpcSocketClient request', () => {
  it('2. task request round-trip resolves with the verified resp payload', async () => {
    respondOnce('done');
    const handle = await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = makeClient(auth);
    await client.connect();

    const payload = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-2',
      type: 'scheduler_list_jobs',
      threadId: THREAD_ID,
    });
    const resp = await client.request('task', payload);

    expect(resp.ok).toBe(true);
    expect(resp.message).toBe('done');
    expect(typeof resp.signature).toBe('string');
    expect(processTaskIpcMock).toHaveBeenCalledTimes(1);
    // Sanity: signature actually verifies under the auth's verify key.
    const { signature, ...withoutSig } = resp as {
      signature?: string;
    } & Record<string, unknown>;
    expect(
      verifyIpcResponsePayload(
        auth.responseVerifyKey,
        withoutSig,
        String(signature),
      ),
    ).toBe(true);
    void handle;
  });

  it('3. bad response signature → fail-closed (rejects with bad_signature, does not resolve)', async () => {
    respondOnce('done');
    await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    // verifyResponse points at the WRONG public key → every resp fails to verify.
    const wrongKey = createIpcResponseSigningKeyPair().publicKeyPem;
    const client = makeClient(auth, { verifyKey: wrongKey });
    await client.connect();

    const payload = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-3',
      type: 'scheduler_list_jobs',
      threadId: THREAD_ID,
    });

    await expect(client.request('task', payload)).rejects.toMatchObject({
      name: 'IpcRequestError',
      code: 'bad_signature',
    });
  });

  it('4. rejected request (handler answers ok:false) rejects with the carried code', async () => {
    processTaskIpcMock.mockImplementation(async (data) => {
      writeTaskIpcResponse(
        FOLDER,
        data.taskId,
        { ok: false, code: 'nope', error: 'x' },
        data.authThreadId,
        data.responseKeyId,
      );
    });
    await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = makeClient(auth);
    await client.connect();

    const payload = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-4',
      type: 'scheduler_list_jobs',
      threadId: THREAD_ID,
    });

    await expect(client.request('task', payload)).rejects.toMatchObject({
      name: 'IpcRequestError',
      code: 'nope',
    });
  });

  it('6. request timeout rejects with code timeout when the handler never responds', async () => {
    // Handler never writes a response → the pending must time out.
    processTaskIpcMock.mockImplementation(async () => {
      await new Promise<void>(() => {
        /* never resolves */
      });
    });
    await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = makeClient(auth);
    await client.connect();

    const payload = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-6',
      type: 'scheduler_list_jobs',
      threadId: THREAD_ID,
    });

    await expect(
      client.request('task', payload, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ name: 'IpcRequestError', code: 'timeout' });
  });

  it('8. replay safety: the same signed payload twice → second rejects, handler ran once', async () => {
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
    await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = makeClient(auth);
    await client.connect();

    // Byte-identical payload (same nonce) reused across two requests.
    const payload = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-replay',
      type: 'scheduler_list_jobs',
      threadId: THREAD_ID,
    });

    const first = await client.request('task', payload, { id: 'r-first' });
    expect(first.ok).toBe(true);

    // The replayed payload is rejected by the server (invalid_request resp).
    await expect(
      client.request('task', payload, { id: 'r-second' }),
    ).rejects.toBeInstanceOf(IpcRequestError);
    expect(handlerCalls).toBe(1);
  });

  it('request() before connect rejects with not_connected', async () => {
    await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = makeClient(auth);
    const payload = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-nc',
      type: 'scheduler_list_jobs',
      threadId: THREAD_ID,
    });
    await expect(client.request('task', payload)).rejects.toMatchObject({
      code: 'not_connected',
    });
  });
});

// ---------------------------------------------------------------------------
// 7. drop rejects pending + reconnect restores service
// ---------------------------------------------------------------------------

describe('IpcSocketClient drop + reconnect', () => {
  it('7. drop rejects pending with connection_lost; reconnect restores a working request', async () => {
    // First server: handler hangs so the request is in-flight when we drop.
    processTaskIpcMock.mockImplementation(async () => {
      await new Promise<void>(() => {
        /* never resolves */
      });
    });
    await startServer(buildDeps());
    const auth = makeAuth(FOLDER, THREAD_ID);
    const client = makeClient(auth, {
      reconnect: { enabled: true, baseDelayMs: 10, maxDelayMs: 50 },
    });
    await client.connect();

    const payload = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-drop',
      type: 'scheduler_list_jobs',
      threadId: THREAD_ID,
    });
    const pending = client.request('task', payload, { timeoutMs: 10_000 });
    const pendingRejected = expect(pending).rejects.toMatchObject({
      code: 'connection_lost',
    });

    // Drop the connection by stopping the server.
    await server!.stop();
    server = undefined;

    await pendingRejected;

    // Restart the server on the SAME socket path; the client should reconnect.
    respondOnce('after-reconnect');
    await startServer(buildDeps());

    // Wait for the client to re-handshake.
    const deadline = Date.now() + 5000;
    while (!client.connected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(client.connected).toBe(true);

    // A NEW request (fresh id + fresh nonce) succeeds on the reconnected socket.
    const payload2 = buildTaskPayload(auth.authToken, auth.responseKeyId, {
      taskId: 'task-after',
      type: 'scheduler_list_jobs',
      threadId: THREAD_ID,
    });
    const resp = await client.request('task', payload2);
    expect(resp.ok).toBe(true);
    expect(resp.message).toBe('after-reconnect');
  });

  it('pure-socket replayPending replays in-flight request with the same frame id after reconnect', async () => {
    const sockets: FakeSocket[] = [];
    const client = new IpcSocketClient({
      socketPath: '/unused.sock',
      buildHello: () => ({ kind: 'hello' }),
      connectFn: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as net.Socket;
      },
      reconnect: {
        enabled: true,
        baseDelayMs: 1,
        maxDelayMs: 1,
        replayPending: true,
      },
      randomFn: () => 0,
    });

    const connecting = client.connect();
    const firstSocket = sockets[0]!;
    const firstHello = parseWritten(firstSocket.written.at(-1)!);
    feed(firstSocket, {
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'welcome',
      id: firstHello.id,
      payload: {},
    });
    await connecting;

    const signedPayload = { signed: 'payload', nonce: 'n1' };
    const pending = client.request('task', signedPayload, {
      id: 'same-request-id',
      timeoutMs: 10_000,
    });
    const firstReq = parseWritten(firstSocket.written.at(-1)!);
    expect(firstReq).toMatchObject({
      type: 'req',
      channel: 'task',
      id: 'same-request-id',
      payload: signedPayload,
    });

    firstSocket.destroy();
    await waitFor(() => sockets.length === 2);

    const secondSocket = sockets[1]!;
    const secondHello = parseWritten(secondSocket.written.at(-1)!);
    feed(secondSocket, {
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'welcome',
      id: secondHello.id,
      payload: {},
    });
    await waitFor(() => secondSocket.written.length >= 2);

    const replayedReq = parseWritten(secondSocket.written.at(-1)!);
    expect(replayedReq).toMatchObject({
      type: 'req',
      channel: 'task',
      id: 'same-request-id',
      payload: signedPayload,
    });

    feed(secondSocket, {
      v: 1,
      type: 'resp',
      channel: 'task',
      id: 'same-request-id',
      payload: { ok: true, message: 'replayed' },
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      message: 'replayed',
    });
    client.close();
  });
});

// ---------------------------------------------------------------------------
// 9. push receive — deterministic fake-socket unit test of handleFrame routing
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory duplex that satisfies net.Socket's surface used by
 * IpcConnection + the client. We capture written frames and can feed inbound
 * frames synchronously, so the welcome/push routing is fully deterministic.
 */
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;
  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    // Auto-emit 'connect' is not needed: client does not wait on connect event.
    return true;
  }
  end(): void {
    /* no-op */
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

import { encodeFrame } from '@core/shared/ipc-frame.js';
import { encodeWireFrame } from '@core/shared/ipc-wire.js';

function feed(socket: FakeSocket, frame: IpcWireFrame): void {
  const body = Buffer.from(encodeWireFrame(frame), 'utf8');
  socket.emit('data', encodeFrame(body));
}

describe('IpcSocketClient push routing (fake socket)', () => {
  it('9. forwards push frames (and unhandled ctrl) to onPush', async () => {
    const fake = new FakeSocket();
    const pushed: IpcWireFrame[] = [];
    const client = new IpcSocketClient({
      socketPath: '/unused.sock',
      buildHello: () => ({ kind: 'hello' }),
      onPush: (f) => pushed.push(f),
      connectFn: () => fake as unknown as net.Socket,
    });

    const connecting = client.connect();
    // Drive the handshake: server-side welcome echoes the hello id.
    const helloFrame = parseWritten(fake.written.at(-1)!);
    feed(fake, {
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'welcome',
      id: helloFrame.id,
      payload: {},
    });
    await connecting;
    expect(client.connected).toBe(true);

    // A push frame on a push channel → routed to onPush.
    feed(fake, {
      v: 1,
      type: 'push',
      channel: 'continuation',
      id: 'p1',
      payload: { hello: 'world' },
    });
    // An unhandled ctrl (e.g. drain) → also routed to onPush.
    feed(fake, {
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'drain',
      id: 'c1',
      payload: {},
    });

    expect(pushed.length).toBe(2);
    expect(pushed[0]?.type).toBe('push');
    expect(pushed[0]?.channel).toBe('continuation');
    expect(pushed[1]?.ctrl).toBe('drain');

    client.close();
  });

  it('busy ctrl carrying a pending id rejects that request with busy', async () => {
    const fake = new FakeSocket();
    const client = new IpcSocketClient({
      socketPath: '/unused.sock',
      buildHello: () => ({ kind: 'hello' }),
      connectFn: () => fake as unknown as net.Socket,
    });
    const connecting = client.connect();
    const helloFrame = parseWritten(fake.written.at(-1)!);
    feed(fake, {
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'welcome',
      id: helloFrame.id,
      payload: {},
    });
    await connecting;

    const pending = client.request('task', { foo: 'bar' }, { id: 'busy-req' });
    feed(fake, {
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'busy',
      id: 'busy-req',
      payload: {},
    });

    await expect(pending).rejects.toMatchObject({ code: 'busy' });
    client.close();
  });

  // confirmedIssue #2 / spec S3 invariant 2: a trusted-socket-no-signature
  // SUCCESS response is forbidden. With verifyResponse configured, a resp whose
  // ok !== false and that carries NO signature field must fail-CLOSED (reject
  // with bad_signature), exactly like the fs verifier — it must NOT fail-OPEN.
  it('fail-closed: a success resp with NO signature + verifyResponse set rejects with bad_signature', async () => {
    const fake = new FakeSocket();
    let verifyCalls = 0;
    const client = new IpcSocketClient({
      socketPath: '/unused.sock',
      buildHello: () => ({ kind: 'hello' }),
      connectFn: () => fake as unknown as net.Socket,
      // A real verifier is wired; it must never be reached for an unsigned
      // success resp because the missing signature is itself the failure.
      verifyResponse: () => {
        verifyCalls += 1;
        return true;
      },
    });
    const connecting = client.connect();
    const helloFrame = parseWritten(fake.written.at(-1)!);
    feed(fake, {
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'welcome',
      id: helloFrame.id,
      payload: {},
    });
    await connecting;

    const pending = client.request('task', { foo: 'bar' }, { id: 'nosig-req' });
    // SUCCESS resp (ok !== false) with NO signature field whatsoever.
    feed(fake, {
      v: 1,
      type: 'resp',
      channel: 'task',
      id: 'nosig-req',
      payload: { ok: true, message: 'unsigned-success' },
    });

    await expect(pending).rejects.toMatchObject({
      name: 'IpcRequestError',
      code: 'bad_signature',
    });
    // The verifier was never even called: a missing signature is the failure.
    expect(verifyCalls).toBe(0);
    client.close();
  });

  it('fail-closed: an application error resp with NO signature + verifyResponse set rejects with bad_signature', async () => {
    const fake = new FakeSocket();
    let verifyCalls = 0;
    const client = new IpcSocketClient({
      socketPath: '/unused.sock',
      buildHello: () => ({ kind: 'hello' }),
      connectFn: () => fake as unknown as net.Socket,
      verifyResponse: () => {
        verifyCalls += 1;
        return true;
      },
    });
    const connecting = client.connect();
    const helloFrame = parseWritten(fake.written.at(-1)!);
    feed(fake, {
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'welcome',
      id: helloFrame.id,
      payload: {},
    });
    await connecting;

    const pending = client.request('task', { foo: 'bar' }, { id: 'err-nosig' });
    feed(fake, {
      v: 1,
      type: 'resp',
      channel: 'task',
      id: 'err-nosig',
      payload: { ok: false, code: 'handler_failed' },
    });

    await expect(pending).rejects.toMatchObject({
      name: 'IpcRequestError',
      code: 'bad_signature',
    });
    expect(verifyCalls).toBe(0);
    client.close();
  });

  // The marked transport-error path (ok === false, transport === true, emitted
  // UNSIGNED by the server) must still settle as a rejection regardless of
  // signature. Unmarked application failures remain fail-closed above.
  it('marked unsigned transport error (ok:false, no signature) still rejects with its carried code', async () => {
    const fake = new FakeSocket();
    const client = new IpcSocketClient({
      socketPath: '/unused.sock',
      buildHello: () => ({ kind: 'hello' }),
      connectFn: () => fake as unknown as net.Socket,
      verifyResponse: () => true,
    });
    const connecting = client.connect();
    const helloFrame = parseWritten(fake.written.at(-1)!);
    feed(fake, {
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'welcome',
      id: helloFrame.id,
      payload: {},
    });
    await connecting;

    const pending = client.request('task', { foo: 'bar' }, { id: 'terr-req' });
    // Mirrors server transportError(): unsigned { ok: false, code, transport }.
    feed(fake, {
      v: 1,
      type: 'resp',
      channel: 'task',
      id: 'terr-req',
      payload: { ok: false, code: 'invalid_request', transport: true },
    });

    await expect(pending).rejects.toMatchObject({
      name: 'IpcRequestError',
      code: 'invalid_request',
    });
    client.close();
  });
});

// Decode a frame we wrote into the fake socket (single frame per write here).
import { FrameDecoder } from '@core/shared/ipc-frame.js';
import { parseWireFrame } from '@core/shared/ipc-wire.js';

function parseWritten(buf: Buffer): IpcWireFrame {
  const bodies = new FrameDecoder().push(buf);
  return parseWireFrame(bodies[0]!.toString('utf8'));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}
