import { describe, expect, it } from 'vitest';

import {
  acceptSocketBindPayload,
  awaitBind,
} from '@core/adapters/llm/anthropic-claude-agent/runner/bind-channel.js';

describe('warm bind channel', () => {
  it('resolves awaitBind from a socket bind push', async () => {
    const bind = awaitBind({ timeoutMs: 1_000 });

    acceptSocketBindPayload({
      chatJid: 'wa:111',
      firstMessage: 'hello from socket bind',
      runHandle: 'bound-run-1',
      memoryBlock: 'memory',
      threadId: 'thread-1',
      ipcAuthToken: 'ipc-token',
      memoryIpcAuthToken: 'memory-token',
      ipcResponseKeyId: 'response-key',
      ipcResponseVerifyKey: 'verify-key',
    });

    await expect(bind).resolves.toEqual({
      chatJid: 'wa:111',
      firstMessage: 'hello from socket bind',
      runHandle: 'bound-run-1',
      memoryBlock: 'memory',
      threadId: 'thread-1',
      ipcAuthToken: 'ipc-token',
      memoryIpcAuthToken: 'memory-token',
      ipcResponseKeyId: 'response-key',
      ipcResponseVerifyKey: 'verify-key',
    });
  });

  it('times out when no socket bind arrives', async () => {
    await expect(awaitBind({ timeoutMs: 1 })).rejects.toThrow(
      'Timed out waiting 1ms for warm bind',
    );
  });
});
