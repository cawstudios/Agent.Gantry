import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSocketContinuationDelivery } from '@core/runtime/continuation-delivery.js';
import {
  startIpcSocketServer,
  type IpcSocketServerHandle,
} from '@core/runtime/ipc-socket-server.js';
import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { createSignedIpcRequestEnvelope } from '@core/runner/mcp/signing.js';
import { encodeFrame, FrameDecoder } from '@core/shared/ipc-frame.js';
import {
  encodeWireFrame,
  parseWireFrame,
  type IpcWireFrame,
} from '@core/shared/ipc-wire.js';
import { clearIpcResponders } from '@core/runtime/ipc-response-router.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import { clearIpcRateLimitState } from '@core/runtime/ipc-rate-limit.js';

// ---------------------------------------------------------------------------
// Fixtures — one folder owning one chat jid (mirrors ipc-socket-transport).
// ---------------------------------------------------------------------------

const FOLDER = 'group-test';
const CHAT_JID = 'wa:1555000@test';
const RUN_HANDLE = 'rh-1';

function buildDeps(): IpcDeps {
  const routes: Record<string, ConversationRoute> = {
    [CHAT_JID]: {
      name: 'Test Group',
      folder: FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
    },
  };
  return {
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
  } as unknown as IpcDeps;
}

// ---------------------------------------------------------------------------
// Fake worker client — real net.connect, framed wire protocol (subset of the
// ipc-socket-transport harness, role:'runner').
// ---------------------------------------------------------------------------

class FakeWorkerClient {
  private readonly socket: net.Socket;
  private readonly decoder = new FrameDecoder();
  private readonly inbound: IpcWireFrame[] = [];
  private waiters: Array<(frame: IpcWireFrame) => void> = [];

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
        // Auto-answer heartbeat pings so the connection stays alive.
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

  sendRaw(frame: IpcWireFrame): void {
    const body = Buffer.from(encodeWireFrame(frame), 'utf8');
    this.socket.write(encodeFrame(body));
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

  async waitForId(id: string, timeoutMs = 5000): Promise<IpcWireFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`waitForId(${id}) timeout`);
      const frame = await this.nextFrame(remaining);
      if (frame.id === id) return frame;
    }
  }

  /** Next non-ctrl frame (i.e. the next push). */
  async nextPush(timeoutMs = 5000): Promise<IpcWireFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('nextPush timeout');
      const frame = await this.nextFrame(remaining);
      if (frame.type !== 'ctrl') return frame;
    }
  }

  async nextPushOnChannel(
    channel: IpcWireFrame['channel'],
    timeoutMs = 5000,
  ): Promise<IpcWireFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(`nextPushOnChannel(${channel}) timeout`);
      const frame = await this.nextPush(remaining);
      if (frame.channel === channel) return frame;
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

function buildRunnerHello(
  authToken: string,
  opts: { folder: string; runHandle: string; threadId?: string },
): Record<string, unknown> {
  return createSignedIpcRequestEnvelope(authToken, {
    kind: 'hello',
    role: 'runner',
    runHandle: opts.runHandle,
    folder: opts.folder,
    context: { threadId: opts.threadId ?? null },
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let server: IpcSocketServerHandle | undefined;
const clients: FakeWorkerClient[] = [];

function socketPathFor(name = 'core.sock'): string {
  return path.join(tmpDir, name);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-delivery-'));
  clearIpcResponders();
  clearConsumedIpcRequestIds();
  clearIpcRateLimitState();
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
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function startServer(): Promise<IpcSocketServerHandle> {
  const handle = await startIpcSocketServer(buildDeps(), {
    socketPath: socketPathFor(),
  });
  if (!handle) throw new Error('server failed to start');
  server = handle;
  return handle;
}

async function handshakeRunner(
  handle: IpcSocketServerHandle,
): Promise<FakeWorkerClient> {
  const client = await FakeWorkerClient.connect(handle.socketPath);
  clients.push(client);
  const auth = createIpcAuthEnvelope(FOLDER, undefined);
  client.sendHello(
    buildRunnerHello(auth.authToken, { folder: FOLDER, runHandle: RUN_HANDLE }),
    'hs',
  );
  const welcome = await client.waitForId('hs');
  expect(welcome.ctrl).toBe('welcome');
  return client;
}

// ---------------------------------------------------------------------------
// makeSocketContinuationDelivery — push to a runHandle-matched runner.
// ---------------------------------------------------------------------------

describe('makeSocketContinuationDelivery (socket transport)', () => {
  it('sends continuation text over the socket and writes no filesystem mailbox', async () => {
    const handle = await startServer();
    const runner = await handshakeRunner(handle);

    const d = makeSocketContinuationDelivery((folder) =>
      handle.connectionsForFolder(folder),
    );

    const delivered = d.deliverContinuation(
      {
        groupFolder: FOLDER,
        chatJid: 'wa:1',
        threadId: null,
        runHandle: RUN_HANDLE,
      },
      'hello',
      0,
    );
    expect(delivered).toBe(true);

    const contFrame = await runner.nextPushOnChannel('continuation');
    expect(contFrame.type).toBe('push');
    expect(contFrame.channel).toBe('continuation');
    expect(contFrame.payload).toMatchObject({
      threadId: null,
      sequence: 0,
      text: 'hello',
    });

    d.deliverClose({
      groupFolder: FOLDER,
      chatJid: 'wa:1',
      threadId: null,
      runHandle: RUN_HANDLE,
    });
    const closeFrame = await runner.nextPushOnChannel('close');
    expect(closeFrame.type).toBe('push');
    expect(closeFrame.channel).toBe('close');
    expect(closeFrame.payload).toMatchObject({ threadId: null });
  });

  it('does not write a fallback when a matched connection drops asynchronously', async () => {
    const handle = await startServer();
    const runner = await handshakeRunner(handle);

    const d = makeSocketContinuationDelivery((folder) =>
      handle.connectionsForFolder(folder),
    );

    runner.destroy();

    const delivered = d.deliverContinuation(
      {
        groupFolder: FOLDER,
        chatJid: 'wa:1',
        threadId: null,
        runHandle: RUN_HANDLE,
      },
      'survives-the-drop',
      7,
    );

    expect(delivered).toBe(true);
  });

  it('returns false when no runHandle-matched connection exists', async () => {
    const handle = await startServer();
    // A runner IS connected, but under RUN_HANDLE — we target a different one.
    await handshakeRunner(handle);

    const d = makeSocketContinuationDelivery((folder) =>
      handle.connectionsForFolder(folder),
    );

    const delivered = d.deliverContinuation(
      {
        groupFolder: FOLDER,
        chatJid: 'wa:1',
        threadId: null,
        runHandle: 'nope',
      },
      'hello',
      5,
    );
    expect(delivered).toBe(false);

    d.deliverClose({
      groupFolder: FOLDER,
      chatJid: 'wa:1',
      threadId: null,
      runHandle: 'nope',
    });
  });

  it('returns false when runHandle is null', () => {
    const d = makeSocketContinuationDelivery(() => []);
    const delivered = d.deliverContinuation(
      { groupFolder: FOLDER, chatJid: 'wa:1', threadId: 't', runHandle: null },
      'hi',
      1,
    );
    expect(delivered).toBe(false);
  });
});
