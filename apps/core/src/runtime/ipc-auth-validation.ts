import fs from 'fs';

import {
  IPC_REQUEST_MAX_AGE_MS,
  validateIpcRequestFreshness,
  verifyIpcRequestPayload,
} from '../infrastructure/ipc/request-signing.js';
import { nowMs } from '../shared/time/datetime.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import {
  normalizeMemoryIpcActions,
  type GantryMemoryIpcAction,
} from '../shared/memory-ipc-actions.js';
import {
  computeBrowserIpcAuthToken,
  computeIpcAuthToken,
  computeMemoryIpcAuthToken,
} from './ipc-auth.js';
import { writePrivateFileSync } from '../shared/private-fs.js';
import { logger } from '../infrastructure/logging/logger.js';

interface IpcThreadBinding {
  appId?: string;
  agentId?: string;
  authThreadId?: string;
  payloadThreadId?: string | null;
  responseKeyId?: string;
}

interface IpcBrowserBinding extends IpcThreadBinding {
  chatJid: string;
}

interface IpcMemoryBinding extends IpcThreadBinding {
  chatJid?: string;
  userId?: string;
  defaultScope?: 'user' | 'group';
  reviewerIsControlApprover?: boolean;
  allowedActions: readonly GantryMemoryIpcAction[];
}

const consumedIpcRequestIds = new Map<string, number>();

// ---------------------------------------------------------------------------
// I-3 (GANTRY_IPC_REPLAY_PERSIST, default off): persist the consumed-requestId
// replay set (key → expiresAtMs) to a private 0o600 file so a captured request
// cannot be replayed across a core restart within its 5-min expiry. When the
// flag is OFF, `replayPersistPath` stays undefined and NOTHING is written or
// read — the set is in-memory only, reset on restart, byte-identical to today.
//
// Storage is append-only JSONL (one {k,e} record per consumed id). Writes are
// cheap (a single appended line, write-through). On load we read every record,
// keep the max expiry per key, drop expired ones, AND rewrite the file
// compacted so it cannot grow unbounded across restarts.
// ---------------------------------------------------------------------------
let replayPersistPath: string | undefined;

function appendReplayRecord(key: string, expiresAt: number): void {
  if (!replayPersistPath) return;
  try {
    writePrivateFileSync(
      replayPersistPath,
      `${JSON.stringify({ k: key, e: expiresAt })}\n`,
      { flag: 'a' },
    );
  } catch (err) {
    // A persist failure must never break request validation — the in-memory set
    // still protects within this process lifetime.
    logger.warn({ err }, 'Failed to persist consumed IPC requestId');
  }
}

/** Single funnel for recording a consumed id: in-memory always; file iff enabled. */
function recordConsumedIpcRequestId(key: string, expiresAt: number): void {
  consumedIpcRequestIds.set(key, expiresAt);
  appendReplayRecord(key, expiresAt);
}

/**
 * I-3: enable replay-set persistence at boot. Loads + prunes any existing file
 * into the in-memory set, then compacts the file to the surviving (unexpired)
 * records. Idempotent and best-effort. Call ONLY when GANTRY_IPC_REPLAY_PERSIST
 * is on; when off this is never called and behavior is unchanged.
 */
export function initConsumedIpcRequestReplayPersistence(
  filePath: string,
): void {
  replayPersistPath = filePath;
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
    if (code !== 'ENOENT') {
      logger.warn({ err, filePath }, 'Failed to read persisted IPC replay set');
    }
    // No file yet (fresh boot) — nothing to load; future writes create it.
    return;
  }
  const now = nowMs();
  let loaded = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as { k?: unknown; e?: unknown };
      const k = typeof rec.k === 'string' ? rec.k : undefined;
      const e =
        typeof rec.e === 'number' && Number.isFinite(rec.e) ? rec.e : undefined;
      if (!k || e === undefined) continue;
      if (e <= now) continue; // expired → drop
      const existing = consumedIpcRequestIds.get(k);
      if (existing === undefined || e > existing) {
        consumedIpcRequestIds.set(k, e);
      }
      loaded += 1;
    } catch {
      // Skip a corrupt line; never abort the load.
    }
  }
  // Compact: rewrite the file to only the surviving records so it cannot grow
  // unbounded across restarts.
  try {
    const compacted = [...consumedIpcRequestIds.entries()]
      .map(([k, e]) => JSON.stringify({ k, e }))
      .join('\n');
    writePrivateFileSync(filePath, compacted ? `${compacted}\n` : '', {
      flag: 'w',
    });
  } catch (err) {
    logger.warn(
      { err, filePath },
      'Failed to compact persisted IPC replay set',
    );
  }
  logger.info(
    { filePath, loaded, live: consumedIpcRequestIds.size },
    'Loaded persisted IPC replay set (GANTRY_IPC_REPLAY_PERSIST)',
  );
}

/** Test seam: disable persistence + forget the path (does not delete the file). */
export function disableConsumedIpcRequestReplayPersistence(): void {
  replayPersistPath = undefined;
}

function readThreadIdField(value: unknown, label: string): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 255, allowEmpty: true });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 255 characters`);
  }
  return parsed;
}

function readPayloadThreadIdField(
  value: unknown,
  label: string,
): string | null | undefined {
  if (value === null) return null;
  return readThreadIdField(value, label);
}

function readResponseKeyIdField(
  value: unknown,
  label: string,
): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 128 });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 128 characters`);
  }
  return parsed;
}

function readAppIdField(value: unknown, label: string): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 128 });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 128 characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function readAgentIdField(value: unknown, label: string): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 200 });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 200 characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function readTrustedThreadBinding(
  raw: Record<string, unknown>,
  label: string,
): IpcThreadBinding {
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const hasContextThreadId =
    !!context && Object.prototype.hasOwnProperty.call(context, 'threadId');
  const hasPayloadThreadId = Object.prototype.hasOwnProperty.call(
    raw,
    'threadId',
  );
  const contextThreadId = hasContextThreadId
    ? readThreadIdField(context?.threadId, `${label} context.threadId`)
    : undefined;
  const payloadThreadId = hasPayloadThreadId
    ? readPayloadThreadIdField(raw.threadId, `${label} threadId`)
    : undefined;

  if (
    hasContextThreadId &&
    hasPayloadThreadId &&
    payloadThreadId !== null &&
    contextThreadId !== payloadThreadId
  ) {
    throw new Error(`${label} threadId mismatch`);
  }

  const trustedThreadId = hasContextThreadId
    ? contextThreadId
    : payloadThreadId;
  const responseKeyId =
    context && Object.prototype.hasOwnProperty.call(context, 'responseKeyId')
      ? readResponseKeyIdField(context.responseKeyId, `${label} responseKeyId`)
      : undefined;
  const contextAppId =
    context && Object.prototype.hasOwnProperty.call(context, 'appId')
      ? readAppIdField(context.appId, `${label} context.appId`)
      : undefined;
  const payloadAppId = Object.prototype.hasOwnProperty.call(raw, 'appId')
    ? readAppIdField(raw.appId, `${label} appId`)
    : undefined;
  if (contextAppId && payloadAppId && contextAppId !== payloadAppId) {
    throw new Error(`${label} appId mismatch`);
  }
  const contextAgentId =
    context && Object.prototype.hasOwnProperty.call(context, 'agentId')
      ? readAgentIdField(context.agentId, `${label} context.agentId`)
      : undefined;
  const payloadAgentId = Object.prototype.hasOwnProperty.call(raw, 'agentId')
    ? readAgentIdField(raw.agentId, `${label} agentId`)
    : undefined;
  if (contextAgentId && payloadAgentId && contextAgentId !== payloadAgentId) {
    throw new Error(`${label} agentId mismatch`);
  }
  return {
    appId: contextAppId ?? payloadAppId,
    agentId: contextAgentId ?? payloadAgentId,
    authThreadId:
      typeof trustedThreadId === 'string' && trustedThreadId
        ? trustedThreadId
        : undefined,
    ...(hasPayloadThreadId ? { payloadThreadId } : {}),
    ...(responseKeyId ? { responseKeyId } : {}),
  };
}

function pruneConsumedIpcRequestIds(): void {
  const now = nowMs();
  for (const [key, expiresAt] of consumedIpcRequestIds) {
    if (expiresAt <= now) {
      consumedIpcRequestIds.delete(key);
    }
  }
}

export function clearConsumedIpcRequestIds(): void {
  consumedIpcRequestIds.clear();
}

export function validateIpcAuthRequest(
  raw: Record<string, unknown>,
  sourceAgentFolder: string,
  label: string,
): IpcThreadBinding {
  const binding = readTrustedThreadBinding(raw, label);
  const signature = toTrimmedString(raw.signature, { maxLen: 512 }) || '';
  const payload = { ...raw };
  delete payload.signature;
  delete payload.authToken;
  const requestSigningKey = computeIpcAuthToken(
    sourceAgentFolder,
    binding.authThreadId,
    { appId: binding.appId, agentId: binding.agentId },
  );
  if (!verifyIpcRequestPayload(requestSigningKey, payload, signature)) {
    throw new Error(`Invalid ${label} signature`);
  }
  const freshness = validateIpcRequestFreshness(payload);
  if (!freshness.ok) {
    throw new Error(`Invalid ${label} freshness: ${freshness.reason}`);
  }
  const requestId = toTrimmedString(payload.requestId, { maxLen: 128 });
  if (requestId) {
    pruneConsumedIpcRequestIds();
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:${requestId}`;
    if (consumedIpcRequestIds.has(replayKey)) {
      throw new Error(`Invalid ${label} replay`);
    }
    recordConsumedIpcRequestId(replayKey, nowMs() + IPC_REQUEST_MAX_AGE_MS);
  }
  return binding;
}

export function validateBrowserIpcAuthRequest(
  raw: Record<string, unknown>,
  sourceAgentFolder: string,
  label: string,
): IpcBrowserBinding {
  const binding = readTrustedThreadBinding(raw, label);
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const chatJid = toTrimmedString(context?.chatJid, { maxLen: 255 });
  if (!chatJid) {
    throw new Error(`${label} context.chatJid is required`);
  }
  const signature = toTrimmedString(raw.signature, { maxLen: 512 }) || '';
  const payload = { ...raw };
  delete payload.signature;
  delete payload.authToken;
  const requestSigningKey = computeBrowserIpcAuthToken(
    sourceAgentFolder,
    chatJid,
    binding.authThreadId,
  );
  if (!verifyIpcRequestPayload(requestSigningKey, payload, signature)) {
    throw new Error(`Invalid ${label} signature`);
  }
  const freshness = validateIpcRequestFreshness(payload);
  if (!freshness.ok) {
    throw new Error(`Invalid ${label} freshness: ${freshness.reason}`);
  }
  const requestId = toTrimmedString(payload.requestId, { maxLen: 128 });
  if (requestId) {
    pruneConsumedIpcRequestIds();
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:${chatJid}:${requestId}`;
    if (consumedIpcRequestIds.has(replayKey)) {
      throw new Error(`Invalid ${label} replay`);
    }
    recordConsumedIpcRequestId(replayKey, nowMs() + IPC_REQUEST_MAX_AGE_MS);
  }
  return { ...binding, chatJid };
}

export function validateMemoryIpcAuthRequest(
  raw: Record<string, unknown>,
  sourceAgentFolder: string,
  label: string,
): IpcMemoryBinding {
  const binding = readTrustedThreadBinding(raw, label);
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const chatJid = toTrimmedString(context?.chatJid, { maxLen: 255 });
  const userId = toTrimmedString(context?.userId, { maxLen: 255 });
  const defaultScopeRaw = toTrimmedString(context?.defaultScope, {
    maxLen: 16,
  });
  const defaultScope =
    defaultScopeRaw === 'user' || defaultScopeRaw === 'group'
      ? defaultScopeRaw
      : undefined;
  const allowedActions = normalizeMemoryIpcActions(
    Array.isArray(context?.allowedActions)
      ? context.allowedActions.filter(
          (action): action is string => typeof action === 'string',
        )
      : undefined,
  );
  const reviewerIsControlApprover = context?.reviewerIsControlApprover === true;
  const signature = toTrimmedString(raw.signature, { maxLen: 512 }) || '';
  const payload = { ...raw };
  delete payload.signature;
  delete payload.authToken;
  const requestSigningKey = computeMemoryIpcAuthToken(sourceAgentFolder, {
    ...(chatJid ? { chatJid } : {}),
    ...(userId ? { userId } : {}),
    defaultScope: defaultScope || 'group',
    threadId: binding.authThreadId,
    allowedActions,
    reviewerIsControlApprover,
  });
  if (!verifyIpcRequestPayload(requestSigningKey, payload, signature)) {
    throw new Error(`Invalid ${label} signature`);
  }
  const freshness = validateIpcRequestFreshness(payload);
  if (!freshness.ok) {
    throw new Error(`Invalid ${label} freshness: ${freshness.reason}`);
  }
  const requestId = toTrimmedString(payload.requestId, { maxLen: 128 });
  if (requestId) {
    pruneConsumedIpcRequestIds();
    const replayKey = `${sourceAgentFolder}:${binding.authThreadId || ''}:memory:${userId || ''}:${defaultScope || 'group'}:${requestId}`;
    if (consumedIpcRequestIds.has(replayKey)) {
      throw new Error(`Invalid ${label} replay`);
    }
    recordConsumedIpcRequestId(replayKey, nowMs() + IPC_REQUEST_MAX_AGE_MS);
  }
  return {
    ...binding,
    ...(chatJid ? { chatJid } : {}),
    ...(userId ? { userId } : {}),
    ...(defaultScope ? { defaultScope } : {}),
    ...(reviewerIsControlApprover ? { reviewerIsControlApprover } : {}),
    allowedActions,
  };
}
