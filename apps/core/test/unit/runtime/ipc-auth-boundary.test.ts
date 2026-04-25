import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { signIpcRequestPayload } from '@core/infrastructure/ipc/request-signing.js';
import { computeIpcAuthToken } from '@core/runtime/ipc-auth.js';
import { stopIpcWatcher, validateIpcAuthRequest } from '@core/runtime/ipc.js';

function signedPayload(
  payload: Record<string, unknown>,
  sourceGroup = 'team',
  threadId?: string,
): Record<string, unknown> {
  const signingKey = computeIpcAuthToken(sourceGroup, threadId);
  return {
    ...payload,
    signature: signIpcRequestPayload(signingKey, payload),
  };
}

describe('validateIpcAuthRequest', () => {
  afterEach(() => {
    stopIpcWatcher();
  });

  it('accepts a signed fresh request and returns the trusted thread binding', () => {
    const payload = {
      requestId: 'perm-1',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      context: { threadId: 'thread-1' },
      threadId: 'thread-1',
    };

    const result = validateIpcAuthRequest(
      signedPayload(payload, 'team', 'thread-1'),
      'team',
      'permission IPC',
    );

    expect(result).toEqual({
      authThreadId: 'thread-1',
      payloadThreadId: 'thread-1',
    });
  });

  it('rejects unsigned or tampered requests at the host boundary', () => {
    const payload = {
      requestId: 'perm-2',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    expect(() =>
      validateIpcAuthRequest(payload, 'team', 'permission IPC'),
    ).toThrow(/Invalid permission IPC signature/);

    const signed = signedPayload(payload);
    expect(() =>
      validateIpcAuthRequest(
        { ...signed, requestId: 'perm-2-tampered' },
        'team',
        'permission IPC',
      ),
    ).toThrow(/Invalid permission IPC signature/);
  });

  it('rejects expired requests and replayed request ids', () => {
    const expired = {
      requestId: 'perm-3',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };

    expect(() =>
      validateIpcAuthRequest(signedPayload(expired), 'team', 'permission IPC'),
    ).toThrow(/expired request/);

    const fresh = {
      requestId: 'perm-4',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const signed = signedPayload(fresh);
    expect(() =>
      validateIpcAuthRequest(signed, 'team', 'permission IPC'),
    ).not.toThrow();
    expect(() =>
      validateIpcAuthRequest(signed, 'team', 'permission IPC'),
    ).toThrow(/replay/);
  });
});
