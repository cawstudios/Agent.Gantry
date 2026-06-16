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
// Fixtures — K folders, each owning one chat jid. The socket carrier resolves
// the live runner connection by (folder, runHandle), so distinct conversations
// are modelled as distinct (folder, runHandle) pairs. validateHello requires
// the folder to be a registered conversation route, so EVERY folder we connect
// must appear in conversationRoutes() below.
// ---------------------------------------------------------------------------

const FOLDER = 'group-test';
const CHAT_JID = 'wa:1555000@test';

/** Conversation folders 0..K-1 used by the multi-conversation isolation case. */
function convFolder(i: number): string {
  return `group-conv-${i}`;
}
function convJid(i: number): string {
  return `wa:1555${String(i).padStart(3, '0')}@test`;
}

/**
 * Deps whose conversationRoutes registers FOLDER plus every convFolder(0..k-1),
 * so each runner hello passes the registered-folder handshake gate.
 */
function buildDeps(extraConvCount = 0): IpcDeps {
  const routes: Record<string, ConversationRoute> = {
    [CHAT_JID]: {
      name: 'Test Group',
      folder: FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
    },
  };
  for (let i = 0; i < extraConvCount; i += 1) {
    routes[convJid(i)] = {
      name: `Conv ${i}`,
      folder: convFolder(i),
      trigger: '',
      added_at: new Date().toISOString(),
    };
  }
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
// Fake worker client — real net.connect, framed wire protocol. Captures inbound
// `push` frames in arrival order (the property under test) and supports a
// bounded wait for "N pushes received".
// ---------------------------------------------------------------------------

class FakeWorkerClient {
  private readonly socket: net.Socket;
  private readonly decoder = new FrameDecoder();
  private readonly inbound: IpcWireFrame[] = [];
  private waiters: Array<(frame: IpcWireFrame) => void> = [];
  /** Every non-ctrl (push) frame, in the exact order the socket delivered it. */
  readonly pushes: IpcWireFrame[] = [];
  private pushWaiters: Array<() => void> = [];

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
        if (frame.type !== 'ctrl') {
          this.pushes.push(frame);
          // Notify every pending count-waiter; each one removes itself only
          // once its own threshold is met (do NOT splice them all here, or an
          // unmet waiter is lost and its promise never resolves).
          for (const w of [...this.pushWaiters]) w();
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

  /** Resolve once at least `n` push frames have arrived, else reject on timeout. */
  waitForPushCount(n: number, timeoutMs = 5000): Promise<void> {
    if (this.pushes.length >= n) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pushWaiters = this.pushWaiters.filter((w) => w !== check);
        reject(
          new Error(
            `waitForPushCount(${n}) timeout — got ${this.pushes.length}`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        if (this.pushes.length >= n) {
          clearTimeout(timer);
          this.pushWaiters = this.pushWaiters.filter((w) => w !== check);
          resolve();
        }
      };
      this.pushWaiters.push(check);
    });
  }

  continuationPushes(): IpcWireFrame[] {
    return this.pushes.filter((frame) => frame.channel === 'continuation');
  }

  deliveryPushes(): IpcWireFrame[] {
    return this.pushes.filter(
      (frame) => frame.channel === 'continuation' || frame.channel === 'close',
    );
  }

  async waitForContinuationPushCount(
    n: number,
    timeoutMs = 5000,
  ): Promise<void> {
    if (this.continuationPushes().length >= n) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pushWaiters = this.pushWaiters.filter((w) => w !== check);
        reject(
          new Error(
            `waitForContinuationPushCount(${n}) timeout — got ${
              this.continuationPushes().length
            }`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        if (this.continuationPushes().length >= n) {
          clearTimeout(timer);
          this.pushWaiters = this.pushWaiters.filter((w) => w !== check);
          resolve();
        }
      };
      this.pushWaiters.push(check);
    });
  }

  async waitForDeliveryPushCount(n: number, timeoutMs = 5000): Promise<void> {
    if (this.deliveryPushes().length >= n) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pushWaiters = this.pushWaiters.filter((w) => w !== check);
        reject(
          new Error(
            `waitForDeliveryPushCount(${n}) timeout — got ${
              this.deliveryPushes().length
            }`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        if (this.deliveryPushes().length >= n) {
          clearTimeout(timer);
          this.pushWaiters = this.pushWaiters.filter((w) => w !== check);
          resolve();
        }
      };
      this.pushWaiters.push(check);
    });
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-socket-ordering-'));
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

async function startServer(deps: IpcDeps): Promise<IpcSocketServerHandle> {
  const handle = await startIpcSocketServer(deps, {
    socketPath: socketPathFor(),
  });
  if (!handle) throw new Error('server failed to start');
  server = handle;
  return handle;
}

/**
 * Connect a runner and complete the hello/welcome handshake for (folder,
 * runHandle). After this resolves the connection is in connectionsForFolder().
 */
async function handshakeRunner(
  handle: IpcSocketServerHandle,
  opts: { folder: string; runHandle: string },
): Promise<FakeWorkerClient> {
  const client = await FakeWorkerClient.connect(handle.socketPath);
  clients.push(client);
  const auth = createIpcAuthEnvelope(opts.folder, undefined);
  client.sendHello(
    buildRunnerHello(auth.authToken, {
      folder: opts.folder,
      runHandle: opts.runHandle,
    }),
    'hs',
  );
  const welcome = await client.waitForId('hs');
  expect(welcome.ctrl).toBe('welcome');
  return client;
}

// ---------------------------------------------------------------------------
// Phase 6.2 — ordering & per-conversation isolation (spec §13.6, §11.22-23)
//
// The socket carrier delivers continuations as `push:continuation` frames over
// the single per-run connection resolved by (folder, runHandle). FIFO and
// isolation are therefore properties of: (a) call-order == wire-order on one
// connection, and (b) the runHandle/folder match selecting exactly one peer.
// These tests assert the OBSERVABLE properties on the wire.
// ---------------------------------------------------------------------------

describe('ipc-socket continuation ordering & isolation', () => {
  // -------------------------------------------------------------------------
  // 1. Continuation FIFO within a conversation (§11.22)
  // -------------------------------------------------------------------------
  it('1. delivers a burst of N continuations strictly FIFO on one connection', async () => {
    const handle = await startServer(buildDeps());
    const RH = 'rh-fifo';
    const runner = await handshakeRunner(handle, {
      folder: FOLDER,
      runHandle: RH,
    });

    const d = makeSocketContinuationDelivery((folder) =>
      handle.connectionsForFolder(folder),
    );

    const N = 50;
    for (let i = 0; i < N; i += 1) {
      const ok = d.deliverContinuation(
        {
          groupFolder: FOLDER,
          chatJid: CHAT_JID,
          threadId: null,
          runHandle: RH,
        },
        `msg-${i}`,
        i,
      );
      // Every delivery resolved the live connection (no fs fallback).
      expect(ok).toBe(true);
    }

    await runner.waitForContinuationPushCount(N);

    const pushes = runner.continuationPushes();
    expect(pushes.length).toBe(N);
    pushes.forEach((frame, i) => {
      expect(frame.type).toBe('push');
      expect(frame.channel).toBe('continuation');
      const payload = frame.payload as { text?: string; sequence?: number };
      expect(payload.text).toBe(`msg-${i}`);
      expect(payload.sequence).toBe(i);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Same-millisecond burst → strictly increasing sequence on receipt
  //    (§11.22 — seq tiebreaker / ordered stream)
  // -------------------------------------------------------------------------
  it('2. preserves strict order under a synchronous same-millisecond burst', async () => {
    const handle = await startServer(buildDeps());
    const RH = 'rh-burst';
    const runner = await handshakeRunner(handle, {
      folder: FOLDER,
      runHandle: RH,
    });

    const d = makeSocketContinuationDelivery((folder) =>
      handle.connectionsForFolder(folder),
    );

    const N = 100;
    // Tight synchronous loop: no awaits between deliveries, so all sends are
    // enqueued within the same tick (effectively same-millisecond).
    for (let i = 0; i < N; i += 1) {
      d.deliverContinuation(
        {
          groupFolder: FOLDER,
          chatJid: CHAT_JID,
          threadId: null,
          runHandle: RH,
        },
        `b-${i}`,
        i,
      );
    }

    await runner.waitForContinuationPushCount(N);
    const pushes = runner.continuationPushes();
    expect(pushes.length).toBe(N);

    // The received sequence values are strictly increasing in arrival order.
    const seqs = pushes.map(
      (f) => (f.payload as { sequence?: number }).sequence as number,
    );
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // And it is exactly 0..N-1 in order (no drops, no reordering).
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  // -------------------------------------------------------------------------
  // 3. N concurrent conversations interleaved → no cross-conversation bleed,
  //    each conversation in order (§11.23, §13.6)
  // -------------------------------------------------------------------------
  it('3. isolates K concurrent conversations with interleaved deliveries (zero bleed)', async () => {
    const K = 5;
    const handle = await startServer(buildDeps(K));

    // One runner per conversation, distinct (folder, runHandle).
    const runners: FakeWorkerClient[] = [];
    const targets: Array<{ folder: string; runHandle: string; jid: string }> =
      [];
    for (let k = 0; k < K; k += 1) {
      const folder = convFolder(k);
      const runHandle = `rh-conv-${k}`;
      runners.push(await handshakeRunner(handle, { folder, runHandle }));
      targets.push({ folder, runHandle, jid: convJid(k) });
    }

    const d = makeSocketContinuationDelivery((folder) =>
      handle.connectionsForFolder(folder),
    );

    // Interleave: round-robin across all K conversations, M messages each. The
    // per-conversation sequence is the round index, so each stream must arrive
    // 0..M-1 in order on its OWN connection and nowhere else.
    const M = 20;
    for (let round = 0; round < M; round += 1) {
      for (let k = 0; k < K; k += 1) {
        const ok = d.deliverContinuation(
          {
            groupFolder: targets[k].folder,
            chatJid: targets[k].jid,
            threadId: null,
            runHandle: targets[k].runHandle,
          },
          `conv${k}-msg${round}`,
          round,
        );
        expect(ok).toBe(true);
      }
    }

    // Each connection must receive EXACTLY its own M messages, in order.
    await Promise.all(runners.map((r) => r.waitForContinuationPushCount(M)));

    for (let k = 0; k < K; k += 1) {
      const pushes = runners[k].continuationPushes();
      expect(pushes.length).toBe(M);
      pushes.forEach((frame, round) => {
        expect(frame.channel).toBe('continuation');
        const payload = frame.payload as { text?: string; sequence?: number };
        expect(payload.text).toBe(`conv${k}-msg${round}`);
        expect(payload.sequence).toBe(round);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 4. Isolation by runHandle within ONE folder — exact runHandle match (R2)
  // -------------------------------------------------------------------------
  it('4. routes by exact runHandle within the same folder (no sibling bleed)', async () => {
    const handle = await startServer(buildDeps());
    const rh1 = 'rh-A';
    const rh2 = 'rh-B';
    // Two runners, SAME folder, different runHandles (e.g. an old + new run, or
    // two runs of the same agent). Both are in connectionsForFolder(FOLDER).
    const connA = await handshakeRunner(handle, {
      folder: FOLDER,
      runHandle: rh1,
    });
    const connB = await handshakeRunner(handle, {
      folder: FOLDER,
      runHandle: rh2,
    });
    expect(handle.connectionsForFolder(FOLDER).length).toBe(2);

    const d = makeSocketContinuationDelivery((folder) =>
      handle.connectionsForFolder(folder),
    );

    // Deliver to rh1 only.
    const ok = d.deliverContinuation(
      {
        groupFolder: FOLDER,
        chatJid: CHAT_JID,
        threadId: null,
        runHandle: rh1,
      },
      'only-for-A',
      0,
    );
    expect(ok).toBe(true);

    await connA.waitForContinuationPushCount(1);
    const pushesA = connA.continuationPushes();
    expect(pushesA.length).toBe(1);
    expect((pushesA[0].payload as { sequence?: number }).sequence).toBe(0);
    expect((pushesA[0].payload as { text?: string }).text).toBe('only-for-A');

    // rh2 must receive nothing. Give the event loop a few turns to surface any
    // erroneous delivery, then assert connB stayed empty.
    await expect(connB.waitForContinuationPushCount(1, 200)).rejects.toThrow(
      /timeout/,
    );
    expect(connB.continuationPushes().length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Close ordering — close arrives AFTER the continuations on that conn
  // -------------------------------------------------------------------------
  it('5. delivers close after preceding continuations (ordered)', async () => {
    const handle = await startServer(buildDeps());
    const RH = 'rh-close';
    const runner = await handshakeRunner(handle, {
      folder: FOLDER,
      runHandle: RH,
    });

    const d = makeSocketContinuationDelivery((folder) =>
      handle.connectionsForFolder(folder),
    );

    const target = {
      groupFolder: FOLDER,
      chatJid: CHAT_JID,
      threadId: null,
      runHandle: RH,
    };
    d.deliverContinuation(target, 'c0', 0);
    d.deliverContinuation(target, 'c1', 1);
    d.deliverClose(target);

    // 3 delivery push frames total: 2 continuations then 1 close, in that exact
    // order. Other runner push channels, such as live_tool_rules, are not part of
    // the continuation carrier under test.
    await runner.waitForDeliveryPushCount(3);
    const pushes = runner.deliveryPushes();
    expect(pushes.length).toBe(3);

    expect(pushes[0].channel).toBe('continuation');
    expect((pushes[0].payload as { sequence?: number }).sequence).toBe(0);
    expect((pushes[0].payload as { text?: string }).text).toBe('c0');
    expect(pushes[1].channel).toBe('continuation');
    expect((pushes[1].payload as { sequence?: number }).sequence).toBe(1);
    expect((pushes[1].payload as { text?: string }).text).toBe('c1');
    // The close lands LAST — never before a continuation that was sent earlier.
    expect(pushes[2].channel).toBe('close');
    expect(pushes[2].type).toBe('push');
  });
});
