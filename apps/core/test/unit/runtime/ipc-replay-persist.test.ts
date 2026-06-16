import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signIpcRequestPayload } from '@core/infrastructure/ipc/request-signing.js';
import { computeIpcAuthToken } from '@core/runtime/ipc-auth.js';
import {
  clearConsumedIpcRequestIds,
  disableConsumedIpcRequestReplayPersistence,
  initConsumedIpcRequestReplayPersistence,
  validateIpcAuthRequest,
} from '@core/runtime/ipc-auth-validation.js';

// ---------------------------------------------------------------------------
// I-3 (GANTRY_IPC_REPLAY_PERSIST, default off): persist the consumed-requestId
// replay set so a captured request cannot be replayed across a restart within
// its 5-min expiry. The flag is wired at boot (runtime-services); here we prove
// the primitive: ON → an id consumed pre-restart is still rejected after a
// "restart" (clear in-memory set + reload from the file); OFF → a reload starts
// empty (today's behavior, set reset on restart).
//
// A "restart" is simulated by clearing the in-memory map (the process boundary)
// and then re-initializing from the on-disk file (what boot does when on).
// ---------------------------------------------------------------------------

const FOLDER = 'team';
const THREAD_ID = 'thread-1';

let tmpDir: string;
let persistPath: string;

function signed(payload: Record<string, unknown>): Record<string, unknown> {
  const signingKey = computeIpcAuthToken(FOLDER, THREAD_ID, {});
  return { ...payload, signature: signIpcRequestPayload(signingKey, payload) };
}

function freshRequest(requestId: string): Record<string, unknown> {
  return signed({
    requestId,
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    context: { threadId: THREAD_ID },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-replay-persist-'));
  persistPath = path.join(tmpDir, '.replay-consumed.jsonl');
  clearConsumedIpcRequestIds();
  disableConsumedIpcRequestReplayPersistence();
});

afterEach(() => {
  // Reset shared module state so cases don't leak into each other.
  clearConsumedIpcRequestIds();
  disableConsumedIpcRequestReplayPersistence();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('IPC replay-set persistence (I-3)', () => {
  it('ON: an id consumed before a restart is still rejected as replay after reload', () => {
    // Boot with persistence enabled (fresh file).
    initConsumedIpcRequestReplayPersistence(persistPath);

    const req = freshRequest('perm-persist-1');
    // First use succeeds and is recorded (in-memory + written through to file).
    expect(() =>
      validateIpcAuthRequest({ ...req }, FOLDER, 'permission IPC'),
    ).not.toThrow();
    // The persisted file now holds the consumed id.
    expect(fs.existsSync(persistPath)).toBe(true);
    expect(fs.readFileSync(persistPath, 'utf8')).toContain('perm-persist-1');

    // Simulate a restart: in-memory set is gone, then boot reloads the file.
    clearConsumedIpcRequestIds();
    disableConsumedIpcRequestReplayPersistence();
    initConsumedIpcRequestReplayPersistence(persistPath);

    // The captured request replayed after restart must STILL be rejected.
    expect(() =>
      validateIpcAuthRequest({ ...req }, FOLDER, 'permission IPC'),
    ).toThrow(/replay/);
  });

  it('OFF: a restart starts with an empty replay set (today behavior)', () => {
    // Persistence NOT enabled (flag off) — validation runs in-memory only.
    const req = freshRequest('perm-offcase-1');
    expect(() =>
      validateIpcAuthRequest({ ...req }, FOLDER, 'permission IPC'),
    ).not.toThrow();
    // Nothing was written (off-case is byte-identical to today).
    expect(fs.existsSync(persistPath)).toBe(false);

    // Simulate a restart: in-memory set reset; with the flag off nothing reloads.
    clearConsumedIpcRequestIds();

    // The same request is accepted again — the set started empty after restart.
    expect(() =>
      validateIpcAuthRequest({ ...req }, FOLDER, 'permission IPC'),
    ).not.toThrow();
  });

  it('prunes expired records on load and compacts the file', () => {
    // Seed the file directly with one expired + one live record.
    const now = Date.now();
    const lines = [
      JSON.stringify({ k: `${FOLDER}:${THREAD_ID}:expired-id`, e: now - 1000 }),
      JSON.stringify({ k: `${FOLDER}:${THREAD_ID}:live-id`, e: now + 60_000 }),
    ].join('\n');
    fs.writeFileSync(persistPath, `${lines}\n`);

    initConsumedIpcRequestReplayPersistence(persistPath);

    // The file is compacted to only the surviving (unexpired) record.
    const compacted = fs.readFileSync(persistPath, 'utf8');
    expect(compacted).toContain('live-id');
    expect(compacted).not.toContain('expired-id');

    // Behaviorally: the live id is treated as already consumed (replay rejected),
    // while an id under the expired key is free again.
    const liveReplay = freshRequest('live-id');
    expect(() =>
      validateIpcAuthRequest(liveReplay, FOLDER, 'permission IPC'),
    ).toThrow(/replay/);

    const expiredReuse = freshRequest('expired-id');
    expect(() =>
      validateIpcAuthRequest(expiredReuse, FOLDER, 'permission IPC'),
    ).not.toThrow();
  });

  it('tolerates a missing file on first boot (no throw, future writes create it)', () => {
    expect(fs.existsSync(persistPath)).toBe(false);
    expect(() =>
      initConsumedIpcRequestReplayPersistence(persistPath),
    ).not.toThrow();

    const req = freshRequest('first-boot-id');
    expect(() =>
      validateIpcAuthRequest(req, FOLDER, 'permission IPC'),
    ).not.toThrow();
    // The write-through created the file.
    expect(fs.existsSync(persistPath)).toBe(true);
  });
});
