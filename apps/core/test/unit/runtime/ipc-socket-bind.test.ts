import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindIpcSocket,
  releaseIpcSocket,
} from '@core/runtime/ipc-socket-bind.js';
import type { SocketBindResult } from '@core/runtime/ipc-socket-bind.js';
import { encodeFrame, FrameDecoder } from '@core/shared/ipc-frame.js';
import { encodeWireFrame, parseWireFrame } from '@core/shared/ipc-wire.js';

// ------- helpers --------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-socket-bind-test-'));
}

/** Remove dir tree, swallowing errors (cleanup in afterEach). */
function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Create a socket FILE on disk that has NO active listener (stale).
 *
 * On macOS, `server.close()` removes the socket file automatically, so we
 * cannot easily leave a real AF_UNIX socket file behind without patching the
 * unlink. Instead we write a plain (non-socket) file at the socket path —
 * `net.connect()` to it returns ENOTSOCK, which our probe treats as stale
 * (identical treatment to ECONNREFUSED/ENOENT).
 */
function createStaleSocketFile(socketPath: string): void {
  fs.writeFileSync(socketPath, '');
}

/**
 * Returns a PID that is definitely NOT alive (not an integer we can signal).
 * 999999 is above the macOS/Linux PID max (typically 99999 / 4194304 but
 * we need something that will NOT be currently running). Use /proc/sys/kernel
 * knowledge OR just rely on ESRCH from process.kill.
 */
function findDeadPid(): number {
  // Try a PID that cannot exist on macOS (max PID = 99998) or that
  // `process.kill(pid, 0)` will ESRCH. We start high and work down.
  for (const candidate of [999999, 500000, 200000]) {
    try {
      process.kill(candidate, 0);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as NodeJS.ErrnoException).code)
          : '';
      if (code === 'ESRCH') return candidate;
    }
  }
  // Fallback: use PID 2 killed? No — just return a very high number;
  // if none of the above are ESRCH we'll get EPERM but the test will note it.
  // In practice on macOS at least one of the above is always dead.
  return 999999;
}

// ------- test state -----------------------------------------------------

let tmpDir: string;
const openResults: SocketBindResult[] = [];

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(async () => {
  // Release all tracked servers
  for (const bound of openResults.splice(0)) {
    await releaseIpcSocket(bound).catch(() => undefined);
  }
  rmrf(tmpDir);
});

function track(r: SocketBindResult): SocketBindResult {
  openResults.push(r);
  return r;
}

// ------- tests ----------------------------------------------------------

describe('bindIpcSocket', () => {
  it('1. clean bind: returns ok:true, server listening, owner file written; releaseIpcSocket cleans up', async () => {
    const socketPath = path.join(tmpDir, 'test.sock');

    const result = await bindIpcSocket({
      socketPath,
      onConnection: () => undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bound = track(result.bound);
    expect(bound.socketPath).toBe(socketPath);
    expect(bound.ownerPath).toBe(`${socketPath}.owner`);
    expect(bound.server.listening).toBe(true);
    expect(fs.statSync(bound.socketPath).mode & 0o777).toBe(0o600);

    // Owner file written with this pid
    const raw = fs.readFileSync(bound.ownerPath, 'utf-8');
    const owner = JSON.parse(raw);
    expect(owner.pid).toBe(process.pid);
    expect(typeof owner.startedAt).toBe('string');
    const ts = Date.parse(owner.startedAt);
    expect(Number.isNaN(ts)).toBe(false);

    // Release cleans up
    openResults.splice(openResults.indexOf(bound), 1);
    await releaseIpcSocket(bound);

    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(bound.ownerPath)).toBe(false);
    expect(bound.server.listening).toBe(false);
  });

  it('2. live owner refuse: second bind on same path returns {ok:false, reason:live_owner}', async () => {
    const socketPath = path.join(tmpDir, 'shared.sock');

    const first = await bindIpcSocket({
      socketPath,
      onConnection: (socket) => socket.destroy(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    track(first.bound);

    // Second binder — should detect live listener via connect probe
    const second = await bindIpcSocket({
      socketPath,
      onConnection: () => undefined,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('live_owner');
  });

  it('2b. live owner probe sends ctrl:ping and refuses when owner answers ctrl:pong', async () => {
    const socketPath = path.join(tmpDir, 'ping-owned.sock');
    const decoder = new FrameDecoder();
    let sawPing = false;
    const owner = net.createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        for (const body of decoder.push(chunk)) {
          const frame = parseWireFrame(body.toString('utf8'));
          if (frame.type !== 'ctrl' || frame.ctrl !== 'ping') continue;
          sawPing = true;
          socket.write(
            encodeFrame(
              Buffer.from(
                encodeWireFrame({
                  v: 1,
                  type: 'ctrl',
                  channel: null,
                  ctrl: 'pong',
                  id: frame.id,
                  payload: {},
                }),
                'utf8',
              ),
            ),
          );
        }
      });
    });
    await new Promise<void>((resolve) => owner.listen(socketPath, resolve));

    try {
      const result = await bindIpcSocket({
        socketPath,
        onConnection: () => undefined,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('live_owner');
      expect(sawPing).toBe(true);
    } finally {
      await new Promise<void>((resolve) => owner.close(() => resolve()));
      fs.rmSync(socketPath, { force: true });
    }
  });

  it('3. stale socket rebind (dead pid): connect-probe ECONNREFUSED + dead pid → unlink + rebind {ok:true}', async () => {
    const socketPath = path.join(tmpDir, 'stale.sock');
    const ownerPath = `${socketPath}.owner`;

    // Create stale socket file with no listener
    createStaleSocketFile(socketPath);

    // Write owner file with a definitely-dead pid
    const deadPid = findDeadPid();
    fs.writeFileSync(
      ownerPath,
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );

    const result = await bindIpcSocket({
      socketPath,
      onConnection: () => undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bound = track(result.bound);
    expect(bound.server.listening).toBe(true);
  });

  it('4. recycled pid rebind: stale socket + alive pid with far-past startedAt → {ok:true}', async () => {
    const socketPath = path.join(tmpDir, 'recycled.sock');
    const ownerPath = `${socketPath}.owner`;

    // Create stale socket file
    createStaleSocketFile(socketPath);

    // Write owner file using OUR pid but with startedAt far in the past
    // (more than 60s before our actual start time) → isRecycledPid returns true.
    // Our actual process start is somewhere near process uptime ago. We set
    // startedAt to 24 hours ago to be safely beyond the 60s skew threshold.
    const farPast = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      ownerPath,
      JSON.stringify({ pid: process.pid, startedAt: farPast }),
      { mode: 0o600 },
    );

    // Use an injectable isRecycled override so the test doesn't depend on
    // actual ps output (which could be slow or platform-specific in CI).
    const result = await bindIpcSocket({
      socketPath,
      onConnection: () => undefined,
      isRecycled: (_pid: number, _startedAt: string | undefined) => true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    track(result.bound);
  });

  it('5. uncertain owner refuse: stale socket + alive pid not recycled → {ok:false, reason:live_owner}', async () => {
    const socketPath = path.join(tmpDir, 'uncertain.sock');
    const ownerPath = `${socketPath}.owner`;

    // Create stale socket file
    createStaleSocketFile(socketPath);

    // Write owner file: alive pid (us), recent startedAt
    const recentStart = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(
      ownerPath,
      JSON.stringify({ pid: process.pid, startedAt: recentStart }),
      { mode: 0o600 },
    );

    // isRecycled override returns false — pid is alive and NOT recycled
    const result = await bindIpcSocket({
      socketPath,
      onConnection: () => undefined,
      isRecycled: (_pid: number, _startedAt: string | undefined) => false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('live_owner');
  });
});

describe('releaseIpcSocket', () => {
  it('is idempotent — calling twice does not throw', async () => {
    const socketPath = path.join(tmpDir, 'idem.sock');

    const result = await bindIpcSocket({
      socketPath,
      onConnection: () => undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bound = result.bound;
    await releaseIpcSocket(bound);
    await expect(releaseIpcSocket(bound)).resolves.not.toThrow();
  });
});

describe('onConnection callback', () => {
  it('is invoked when a client connects to the socket', async () => {
    const socketPath = path.join(tmpDir, 'conn.sock');
    let gotConnection = false;

    const result = await bindIpcSocket({
      socketPath,
      onConnection: (socket) => {
        gotConnection = true;
        socket.destroy();
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    track(result.bound);

    await new Promise<void>((resolve, reject) => {
      const client = net.connect(socketPath, () => {
        client.destroy();
        resolve();
      });
      client.once('error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 2000);
    });

    // Give the server a tick to fire the connection handler
    await new Promise((r) => setImmediate(r));
    expect(gotConnection).toBe(true);
  });
});
