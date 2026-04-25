import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { createIpcResponseSigningKeyPair } from '../infrastructure/ipc/response-signing.js';
import { MYCLAW_IPC_AUTH_SECRET } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';

const IPC_AUTH_SECRET =
  MYCLAW_IPC_AUTH_SECRET ||
  (() => {
    const generated = randomBytes(32).toString('hex');
    logger.warn(
      'MYCLAW_IPC_AUTH_SECRET not set; using ephemeral secret (IPC tokens will not survive restarts)',
    );
    return generated;
  })();

function authScope(groupFolder: string, threadId?: string | null): string {
  const normalizedThreadId = threadId?.trim();
  return normalizedThreadId
    ? `${groupFolder}\0thread\0${normalizedThreadId}`
    : groupFolder;
}

function responseScope(groupFolder: string, threadId?: string | null): string {
  return `response\0${authScope(groupFolder, threadId)}`;
}

const responseSigningKeys = new Map<
  string,
  { publicKeyPem: string; privateKeyPem: string }
>();

export function computeIpcAuthToken(
  groupFolder: string,
  threadId?: string | null,
): string {
  return createHmac('sha256', IPC_AUTH_SECRET)
    .update(authScope(groupFolder, threadId))
    .digest('hex');
}

export function validateIpcAuthToken(
  groupFolder: string,
  candidateToken: string,
  threadId?: string | null,
): boolean {
  if (!candidateToken) return false;
  const expected = computeIpcAuthToken(groupFolder, threadId);
  if (candidateToken.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidateToken), Buffer.from(expected));
}

export function createIpcAuthEnvelope(
  groupFolder: string,
  threadId?: string | null,
): {
  authToken: string;
  responseVerifyKey: string;
} {
  const scope = responseScope(groupFolder, threadId);
  const keys = createIpcResponseSigningKeyPair();
  responseSigningKeys.set(scope, keys);
  return {
    authToken: computeIpcAuthToken(groupFolder, threadId),
    responseVerifyKey: keys.publicKeyPem,
  };
}

export function getIpcResponseSigningPrivateKey(
  groupFolder: string,
  threadId?: string | null,
): string | undefined {
  return responseSigningKeys.get(responseScope(groupFolder, threadId))
    ?.privateKeyPem;
}
