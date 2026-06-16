import fs from 'fs';
import net from 'net';
import path from 'path';
import { execFileSync } from 'child_process';

import { logger } from '../infrastructure/logging/logger.js';
import {
  ensurePrivateDirSync,
  PRIVATE_FILE_MODE,
  writePrivateFileSync,
} from '../shared/private-fs.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import { encodeFrame, FrameDecoder } from '../shared/ipc-frame.js';
import { encodeWireFrame, parseWireFrame } from '../shared/ipc-wire.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SocketBindResult {
  /** A listening net.Server. */
  server: net.Server;
  socketPath: string;
  /** Sidecar file at `${socketPath}.owner` holding {pid, startedAt}. */
  ownerPath: string;
}

export type SocketBindOutcome =
  | { ok: true; bound: SocketBindResult }
  | {
      ok: false;
      reason: 'live_owner' | 'error';
      detail?: string;
    };

// ─── PID liveness / recycle detection ─────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as NodeJS.ErrnoException).code)
        : '';
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    logger.warn(
      { err, pid },
      'Unable to validate IPC socket owner PID liveness, assuming process is active',
    );
    return true;
  }
}

function processStartTimeMs(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    if (!out) return undefined;
    const parsed = Date.parse(out);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

const PID_RECYCLE_SKEW_MS = 60_000;

function isRecycledPidDefault(
  pid: number,
  recordedStartedAt: string | undefined,
): boolean {
  if (!recordedStartedAt) return false;
  const recordedMs = Date.parse(recordedStartedAt);
  if (Number.isNaN(recordedMs)) return false;
  const actualMs = processStartTimeMs(pid);
  if (actualMs === undefined) return false;
  return actualMs - recordedMs > PID_RECYCLE_SKEW_MS;
}

// ─── Owner file parsing ────────────────────────────────────────────────────────

interface OwnerDetails {
  pid?: number;
  startedAt?: string;
}

function readOwnerFile(ownerPath: string): OwnerDetails {
  try {
    const raw = fs.readFileSync(ownerPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return {};
    const pidRaw = parsed.pid;
    const pid =
      typeof pidRaw === 'number' && Number.isInteger(pidRaw) && pidRaw > 0
        ? pidRaw
        : undefined;
    const startedAt = toTrimmedString(parsed.startedAt, { maxLen: 128 });
    return { pid, startedAt };
  } catch {
    return {};
  }
}

// ─── Connect probe ────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 500;

/**
 * Returns true if a listener is alive on socketPath (connect succeeded or
 * uncertain due to timeout), false if the socket is stale (ECONNREFUSED /
 * ENOENT).
 *
 * Conservative: timeout → assume live (don't steal).
 */
function probeSocketLiveness(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const decoder = new FrameDecoder();
    const probe = net.connect(socketPath);
    const pingId = `bind-probe-${process.pid}-${Date.now()}`;

    const settle = (live: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(live);
    };

    const timer = setTimeout(() => {
      // Timed out — conservative: treat as live
      settle(true);
    }, PROBE_TIMEOUT_MS);

    probe.once('connect', () => {
      probe.write(
        encodeFrame(
          Buffer.from(
            encodeWireFrame({
              v: 1,
              type: 'ctrl',
              channel: null,
              ctrl: 'ping',
              id: pingId,
              payload: {},
            }),
            'utf8',
          ),
        ),
      );
    });

    probe.on('data', (chunk: Buffer) => {
      try {
        for (const body of decoder.push(chunk)) {
          const frame = parseWireFrame(body.toString('utf8'));
          if (
            frame.type === 'ctrl' &&
            frame.ctrl === 'pong' &&
            frame.id === pingId
          ) {
            settle(true);
            return;
          }
        }
      } catch {
        // Any unexpected probe response is uncertain; do not steal the socket.
        settle(true);
      }
    });

    probe.once('error', (err) => {
      if (settled) return;
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as NodeJS.ErrnoException).code)
          : '';
      if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ENOTSOCK') {
        settle(false); // stale/corrupt socket file
      } else {
        // Unexpected error — conservative
        settle(true);
      }
    });
  });
}

// ─── Server listen / EADDRINUSE detection ─────────────────────────────────────

function listenOnSocket(
  server: net.Server,
  socketPath: string,
): Promise<void | 'EADDRINUSE'> {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as NodeJS.ErrnoException).code)
          : '';
      if (code === 'EADDRINUSE') {
        resolve('EADDRINUSE');
      } else {
        reject(err);
      }
    });
    server.listen(socketPath, () => resolve());
  });
}

// ─── Stale recovery (owner-file path) ────────────────────────────────────────

type RecoveryDecision =
  | { action: 'rebind' }
  | { action: 'refuse'; reason: 'live_owner' };

function decideOwnerRecovery(
  ownerPath: string,
  isRecycled: (pid: number, startedAt: string | undefined) => boolean,
): RecoveryDecision {
  const details = readOwnerFile(ownerPath);

  if (typeof details.pid !== 'number') {
    // Missing / invalid pid → stale, clear it
    return { action: 'rebind' };
  }

  if (!isProcessAlive(details.pid)) {
    return { action: 'rebind' };
  }

  // Pid alive — check for recycling
  if (isRecycled(details.pid, details.startedAt)) {
    return { action: 'rebind' };
  }

  // Pid alive and NOT recycled → conservatively refuse
  return { action: 'refuse', reason: 'live_owner' };
}

function unlinkStaleFiles(socketPath: string, ownerPath: string): void {
  for (const p of [socketPath, ownerPath]) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      logger.warn({ err, path: p }, 'Failed to remove stale IPC socket file');
    }
  }
}

function hardenSocketFile(socketPath: string): void {
  const st = fs.lstatSync(socketPath);
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to use IPC socket symlink: ${socketPath}`);
  }
  fs.chmodSync(socketPath, PRIVATE_FILE_MODE);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Bind the core IPC socket with election. onConnection is attached to the
 * server's 'connection' event.
 *
 * Steps:
 *  1. ensurePrivateDirSync on the parent directory.
 *  2. Try to listen on socketPath.
 *  3. EADDRINUSE → probe for live listener:
 *     - connect succeeds (or times out) → {ok:false, reason:'live_owner'}.
 *     - connect fails ECONNREFUSED/ENOENT → run owner-file recovery, then
 *       retry listen once.
 *  4. Successful listen → write owner file, attach onConnection, return
 *     {ok:true, bound}.
 */
export async function bindIpcSocket(opts: {
  socketPath: string;
  onConnection: (socket: net.Socket) => void;
  nowIso?: () => string;
  /** Injectable for tests; defaults to the real isRecycledPidDefault. */
  isRecycled?: (pid: number, startedAt: string | undefined) => boolean;
}): Promise<SocketBindOutcome> {
  const {
    socketPath,
    onConnection,
    nowIso = () => new Date().toISOString(),
    isRecycled = isRecycledPidDefault,
  } = opts;
  const ownerPath = `${socketPath}.owner`;

  // Step 1: ensure parent dir
  ensurePrivateDirSync(path.dirname(socketPath));

  // Step 2: initial listen attempt
  const server = net.createServer();
  const firstResult = await listenOnSocket(server, socketPath);

  if (firstResult !== 'EADDRINUSE') {
    // Success on first try
    hardenSocketFile(socketPath);
    writeOwnerAndAttach(server, ownerPath, onConnection, nowIso);
    return { ok: true, bound: { server, socketPath, ownerPath } };
  }

  // Step 3: EADDRINUSE — probe
  const liveListener = await probeSocketLiveness(socketPath);

  if (liveListener) {
    // Another core is genuinely listening
    server.close();
    return { ok: false, reason: 'live_owner' };
  }

  // Stale socket file (no listener) — run owner-file recovery
  const decision = decideOwnerRecovery(ownerPath, isRecycled);

  if (decision.action === 'refuse') {
    server.close();
    return { ok: false, reason: 'live_owner' };
  }

  // Unlink stale files and retry listen once
  unlinkStaleFiles(socketPath, ownerPath);

  const retryResult = await listenOnSocket(server, socketPath);
  if (retryResult === 'EADDRINUSE') {
    server.close();
    return { ok: false, reason: 'error', detail: 'reacquire_raced' };
  }

  // Retry succeeded
  hardenSocketFile(socketPath);
  writeOwnerAndAttach(server, ownerPath, onConnection, nowIso);
  return { ok: true, bound: { server, socketPath, ownerPath } };
}

function writeOwnerAndAttach(
  server: net.Server,
  ownerPath: string,
  onConnection: (socket: net.Socket) => void,
  nowIso: () => string,
): void {
  writePrivateFileSync(
    ownerPath,
    JSON.stringify({ pid: process.pid, startedAt: nowIso() }),
  );
  server.on('connection', onConnection);
}

/**
 * Release: close server, unlink socket + owner file.
 * Idempotent — swallows ENOENT.
 */
export async function releaseIpcSocket(bound: SocketBindResult): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!bound.server.listening) {
      resolve();
      return;
    }
    // The server's stop() destroys all connections before calling release, so
    // server.close(cb) resolves once the listener is torn down.
    bound.server.close(() => resolve());
  });

  for (const p of [bound.socketPath, bound.ownerPath]) {
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as NodeJS.ErrnoException).code)
          : '';
      if (code !== 'ENOENT') {
        logger.warn(
          { err, path: p },
          'Failed to remove IPC socket file on release',
        );
      }
    }
  }
}
