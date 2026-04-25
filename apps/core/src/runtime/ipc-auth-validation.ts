import {
  IPC_REQUEST_MAX_AGE_MS,
  validateIpcRequestFreshness,
  verifyIpcRequestPayload,
} from '../infrastructure/ipc/request-signing.js';
import { nowMs } from '../infrastructure/time/datetime.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import { computeIpcAuthToken } from './ipc-auth.js';

interface IpcThreadBinding {
  authThreadId?: string;
  payloadThreadId?: string;
}

const consumedIpcRequestIds = new Map<string, number>();

function readThreadIdField(value: unknown, label: string): string | undefined {
  const parsed = toTrimmedString(value, { maxLen: 255, allowEmpty: true });
  if (parsed === undefined) {
    throw new Error(`${label} must be a string up to 255 characters`);
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
    ? readThreadIdField(raw.threadId, `${label} threadId`)
    : undefined;

  if (
    hasContextThreadId &&
    hasPayloadThreadId &&
    contextThreadId !== payloadThreadId
  ) {
    throw new Error(`${label} threadId mismatch`);
  }

  const trustedThreadId = hasContextThreadId
    ? contextThreadId
    : payloadThreadId;
  return {
    authThreadId: trustedThreadId || undefined,
    ...(hasPayloadThreadId ? { payloadThreadId } : {}),
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
  sourceGroup: string,
  label: string,
): IpcThreadBinding {
  const binding = readTrustedThreadBinding(raw, label);
  const signature = toTrimmedString(raw.signature, { maxLen: 512 }) || '';
  const payload = { ...raw };
  delete payload.signature;
  delete payload.authToken;
  const requestSigningKey = computeIpcAuthToken(
    sourceGroup,
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
    const replayKey = `${sourceGroup}:${binding.authThreadId || ''}:${requestId}`;
    if (consumedIpcRequestIds.has(replayKey)) {
      throw new Error(`Invalid ${label} replay`);
    }
    consumedIpcRequestIds.set(replayKey, nowMs() + IPC_REQUEST_MAX_AGE_MS);
  }
  return binding;
}
