import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryIpcResponse } from '@gantry/contracts';

import {
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import {
  createIpcAuthEnvelope,
  getIpcResponseSigningPrivateKey,
} from '@core/runtime/ipc-auth.js';
import {
  clearIpcResponders,
  hasIpcResponder,
  registerIpcResponder,
  takeIpcResponder,
} from '@core/runtime/ipc-response-router.js';
import { writeTaskIpcResponse } from '@core/jobs/ipc-shared.js';
import { writeMemoryResponse } from '@core/memory/memory-ipc.js';
import {
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from '@core/runtime/ipc-interaction-handler.js';
import { writeBrowserIpcResponse } from '@core/runtime/ipc-browser-handler.js';

const FOLDER = 'team';

function setupSigningKey(folder = FOLDER, threadId?: string) {
  return createIpcAuthEnvelope(folder, threadId ?? null);
}

function expectValidSignature(
  signed: Record<string, unknown>,
  verifyKey: string,
): void {
  const { signature, ...withoutSig } = signed;
  expect(typeof signature).toBe('string');
  expect(
    verifyIpcResponsePayload(
      verifyKey,
      withoutSig as Record<string, unknown>,
      signature as string,
    ),
  ).toBe(true);
}

describe('ipc-response-router registry', () => {
  afterEach(() => {
    clearIpcResponders();
  });

  it('returns undefined for an unregistered key', () => {
    expect(takeIpcResponder('folder-a', 'task-x')).toBeUndefined();
  });

  it('registers, replaces, consumes, isolates, and clears responders', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerIpcResponder('folder-a', 'task-x', first);
    registerIpcResponder('folder-a', 'task-x', second);

    expect(hasIpcResponder('folder-a', 'task-x')).toBe(true);
    expect(hasIpcResponder('folder-b', 'task-x')).toBe(false);
    expect(hasIpcResponder('folder-a', 'task-y')).toBe(false);
    expect(takeIpcResponder('folder-a', 'task-x')).toBe(second);
    expect(hasIpcResponder('folder-a', 'task-x')).toBe(false);

    registerIpcResponder('folder-a', 'task-1', vi.fn());
    registerIpcResponder('folder-b', 'task-2', vi.fn());
    clearIpcResponders();
    expect(hasIpcResponder('folder-a', 'task-1')).toBe(false);
    expect(hasIpcResponder('folder-b', 'task-2')).toBe(false);
  });
});

describe('socket-only IPC response writers', () => {
  let envelope: ReturnType<typeof setupSigningKey>;

  beforeEach(() => {
    envelope = setupSigningKey(FOLDER);
  });

  afterEach(() => {
    clearIpcResponders();
  });

  it('delivers signed task responses to a registered socket responder', () => {
    const taskId = 'task-1';
    const received: Record<string, unknown>[] = [];
    registerIpcResponder(FOLDER, `task-${taskId}`, (signed) => {
      received.push(signed);
    });

    writeTaskIpcResponse(
      FOLDER,
      taskId,
      { ok: true, message: 'socket' },
      undefined,
      envelope.responseKeyId,
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      taskId,
      ok: true,
      message: 'socket',
    });
    expectValidSignature(received[0], envelope.responseVerifyKey);
    expect(hasIpcResponder(FOLDER, `task-${taskId}`)).toBe(false);
  });

  it('throws for task responses when no socket responder is registered', () => {
    expect(() =>
      writeTaskIpcResponse(
        FOLDER,
        'task-missing',
        { ok: true },
        undefined,
        envelope.responseKeyId,
      ),
    ).toThrow('No socket IPC responder registered for task response');
  });

  it('keeps the task responder registered when response signing fails', () => {
    const responder = vi.fn();
    registerIpcResponder(FOLDER, 'task-task-nosign', responder);

    writeTaskIpcResponse(
      FOLDER,
      'task-nosign',
      { ok: true },
      undefined,
      'nonexistent-key-id',
    );

    expect(responder).not.toHaveBeenCalled();
    expect(hasIpcResponder(FOLDER, 'task-task-nosign')).toBe(true);
  });

  it('delivers signed memory responses to a registered socket responder', () => {
    const requestId = 'memory-1';
    const received: Record<string, unknown>[] = [];
    const signingKey = getIpcResponseSigningPrivateKey(
      FOLDER,
      undefined,
      envelope.responseKeyId,
    );
    registerIpcResponder(FOLDER, `memory-${requestId}`, (signed) => {
      received.push(signed);
    });

    const response: MemoryIpcResponse = {
      ok: true,
      requestId,
      provider: 'postgres',
      data: { results: [] },
    };
    writeMemoryResponse(FOLDER, requestId, response, signingKey);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject(response);
    expectValidSignature(received[0], envelope.responseVerifyKey);
  });

  it('throws for memory responses when no socket responder is registered', () => {
    const response: MemoryIpcResponse = {
      ok: true,
      requestId: 'memory-missing',
      provider: 'postgres',
    };

    expect(() =>
      writeMemoryResponse(
        FOLDER,
        response.requestId,
        response,
        getIpcResponseSigningPrivateKey(
          FOLDER,
          undefined,
          envelope.responseKeyId,
        ),
      ),
    ).toThrow('No socket IPC responder registered for memory response');
  });

  it('delivers signed permission responses to a registered socket responder', () => {
    const requestId = 'perm-1';
    const received: Record<string, unknown>[] = [];
    registerIpcResponder(FOLDER, `permission-${requestId}`, (signed) => {
      received.push(signed);
    });

    writePermissionIpcResponse(
      '/unused',
      FOLDER,
      { requestId, approved: true, mode: 'allow_once' },
      getIpcResponseSigningPrivateKey(
        FOLDER,
        undefined,
        envelope.responseKeyId,
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      requestId,
      approved: true,
      mode: 'allow_once',
    });
    expectValidSignature(received[0], envelope.responseVerifyKey);
  });

  it('throws for permission responses when no socket responder is registered', () => {
    expect(() =>
      writePermissionIpcResponse(
        '/unused',
        FOLDER,
        { requestId: 'perm-missing', approved: false },
        getIpcResponseSigningPrivateKey(
          FOLDER,
          undefined,
          envelope.responseKeyId,
        ),
      ),
    ).toThrow('No socket IPC responder registered for permission response');
  });

  it('delivers signed user-question responses to a registered socket responder', () => {
    const requestId = 'question-1';
    const received: Record<string, unknown>[] = [];
    registerIpcResponder(FOLDER, `userq-${requestId}`, (signed) => {
      received.push(signed);
    });

    writeUserQuestionIpcResponse(
      '/unused',
      FOLDER,
      { requestId, answers: { Size: 'M' }, answeredBy: 'admin' },
      getIpcResponseSigningPrivateKey(
        FOLDER,
        undefined,
        envelope.responseKeyId,
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      requestId,
      answers: { Size: 'M' },
      answeredBy: 'admin',
    });
    expectValidSignature(received[0], envelope.responseVerifyKey);
  });

  it('throws for user-question responses when no socket responder is registered', () => {
    expect(() =>
      writeUserQuestionIpcResponse(
        '/unused',
        FOLDER,
        { requestId: 'question-missing', answers: {} },
        getIpcResponseSigningPrivateKey(
          FOLDER,
          undefined,
          envelope.responseKeyId,
        ),
      ),
    ).toThrow('No socket IPC responder registered for user-question response');
  });

  it('delivers signed browser responses to a registered socket responder', () => {
    const requestId = 'browser-1';
    const received: Record<string, unknown>[] = [];
    registerIpcResponder(FOLDER, `browser-${requestId}`, (signed) => {
      received.push(signed);
    });

    writeBrowserIpcResponse(
      '/unused',
      FOLDER,
      { requestId, ok: true, data: { running: true } },
      getIpcResponseSigningPrivateKey(
        FOLDER,
        undefined,
        envelope.responseKeyId,
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      requestId,
      ok: true,
      data: { running: true },
    });
    expectValidSignature(received[0], envelope.responseVerifyKey);
  });

  it('throws for browser responses when no socket responder is registered', () => {
    expect(() =>
      writeBrowserIpcResponse(
        '/unused',
        FOLDER,
        { requestId: 'browser-missing', ok: true },
        getIpcResponseSigningPrivateKey(
          FOLDER,
          undefined,
          envelope.responseKeyId,
        ),
      ),
    ).toThrow('No socket IPC responder registered for browser response');
  });
});
