/**
 * Runtime-bound customer identity for the gantry-MCP child (Pillar 2, D-P2-2(a),
 * F4).
 *
 * Today the gantry-MCP stdio child reads `GANTRY_CHAT_JID` (+ thread / memory
 * user) as ENV CONSTANTS at its own spawn and stamps them on every outbound IPC
 * task. A pre-warmed worker boots GENERIC, so its MCP child has no (or the
 * wrong) customer identity — it must read the BOUND identity at runtime,
 * per call.
 *
 * This accessor returns the bound identity when a bound-identity SOURCE is
 * present (the warm-pool shim writes `bound-identity.json` under
 * `GANTRY_IPC_DIR` at bind; re-read per call so a late bind is honored), and
 * otherwise falls back to the spawn-env constant (the cold path — byte
 * identical). The source is pluggable so the Pillar-1 socket replaces the file
 * source at combine time without touching the readers.
 *
 * Security: core re-validates the chatJid scope on every IPC message
 * (memory-IPC token, caller-identity), so a runtime-bound identity is validated
 * downstream exactly as a spawn-baked one is — a mis-bound or blank identity
 * fails closed.
 */
import fs from 'fs';
import path from 'path';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../../shared/private-fs.js';

export interface BoundIdentity {
  chatJid: string;
  threadId?: string;
  memoryUserId?: string;
  ipcAuthToken?: string;
  browserIpcAuthToken?: string;
  memoryIpcAuthToken?: string;
  ipcResponseKeyId?: string;
  ipcResponseVerifyKey?: string;
}

export interface BoundIdentitySource {
  /** Read the current bound identity, or undefined if none is bound. */
  read(): BoundIdentity | undefined;
}

const BOUND_IDENTITY_FILE = 'bound-identity.json';

function envIdentity(): BoundIdentity {
  return {
    // Trim to match the runtime-env `CHAT_JID` (= GANTRY_CHAT_JID, trimmed), so
    // the cold-path fallback here is byte-for-byte identical to the old
    // permission-callback `|| CHAT_JID` operand it replaces.
    chatJid: process.env.GANTRY_CHAT_JID?.trim() ?? '',
    threadId: process.env.GANTRY_THREAD_ID?.trim() || undefined,
    memoryUserId: process.env.GANTRY_MEMORY_USER_ID?.trim() || undefined,
    ipcAuthToken: process.env.GANTRY_IPC_AUTH_TOKEN || undefined,
    browserIpcAuthToken: process.env.GANTRY_BROWSER_IPC_AUTH_TOKEN || undefined,
    memoryIpcAuthToken: process.env.GANTRY_MEMORY_IPC_AUTH_TOKEN || undefined,
    ipcResponseKeyId: process.env.GANTRY_IPC_RESPONSE_KEY_ID || undefined,
    ipcResponseVerifyKey:
      process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY || undefined,
  };
}

/**
 * The default shim source: a JSON file under `GANTRY_IPC_DIR`, written at bind
 * and re-read on every call (so the latest bind wins and a worker recycled to a
 * new conversation never serves a stale identity).
 */
function fileSource(): BoundIdentity | undefined {
  const ipcDir = process.env.GANTRY_IPC_DIR;
  if (!ipcDir) return undefined;
  const filePath = path.join(ipcDir, BOUND_IDENTITY_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined; // not bound yet (cold path / pre-bind)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BoundIdentity>;
    if (!parsed || typeof parsed.chatJid !== 'string' || !parsed.chatJid) {
      return undefined;
    }
    return {
      chatJid: parsed.chatJid,
      threadId:
        typeof parsed.threadId === 'string' && parsed.threadId.trim()
          ? parsed.threadId
          : undefined,
      memoryUserId:
        typeof parsed.memoryUserId === 'string' && parsed.memoryUserId.trim()
          ? parsed.memoryUserId
          : undefined,
      ipcAuthToken:
        typeof parsed.ipcAuthToken === 'string' && parsed.ipcAuthToken.trim()
          ? parsed.ipcAuthToken
          : undefined,
      browserIpcAuthToken:
        typeof parsed.browserIpcAuthToken === 'string' &&
        parsed.browserIpcAuthToken.trim()
          ? parsed.browserIpcAuthToken
          : undefined,
      memoryIpcAuthToken:
        typeof parsed.memoryIpcAuthToken === 'string' &&
        parsed.memoryIpcAuthToken.trim()
          ? parsed.memoryIpcAuthToken
          : undefined,
      ipcResponseKeyId:
        typeof parsed.ipcResponseKeyId === 'string' &&
        parsed.ipcResponseKeyId.trim()
          ? parsed.ipcResponseKeyId
          : undefined,
      ipcResponseVerifyKey:
        typeof parsed.ipcResponseVerifyKey === 'string' &&
        parsed.ipcResponseVerifyKey.trim()
          ? parsed.ipcResponseVerifyKey
          : undefined,
    };
  } catch {
    return undefined;
  }
}

let activeSource: BoundIdentitySource = { read: fileSource };

/** Override the bound-identity source (Pillar-1 socket swaps in at combine). */
export function setBoundIdentitySource(source: BoundIdentitySource): void {
  activeSource = source;
}

/** Reset to the default file source (test isolation). */
export function resetBoundIdentitySource(): void {
  activeSource = { read: fileSource };
}

/**
 * The current customer identity: the runtime-bound identity when present, else
 * the spawn-env constant. Re-read per call.
 */
export function getBoundIdentity(): BoundIdentity {
  const bound = activeSource.read();
  if (bound) return bound;
  return envIdentity();
}

/** The current runtime scope: bound warm scope when present, else env scope. */
export function getBoundRuntimeScope(): BoundIdentity {
  return getBoundIdentity();
}

/** The current customer chatJid (bound when present, else spawn-env constant). */
export function getBoundChatJid(): string {
  return getBoundIdentity().chatJid;
}

/** The current customer thread id (bound when present, else spawn-env constant). */
export function getBoundThreadId(): string | undefined {
  return getBoundIdentity().threadId;
}

/** Write the bound identity to the shim file source (used at bind / in tests). */
export function writeBoundIdentityFile(
  ipcDir: string,
  identity: BoundIdentity,
): void {
  ensurePrivateDirSync(ipcDir);
  const filePath = path.join(ipcDir, BOUND_IDENTITY_FILE);
  const tmpPath = `${filePath}.tmp`;
  writePrivateFileSync(tmpPath, JSON.stringify(identity, null, 2));
  fs.renameSync(tmpPath, filePath);
}
