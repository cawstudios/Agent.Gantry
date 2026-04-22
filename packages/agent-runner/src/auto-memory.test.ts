import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  configureAutoMemory,
  processAutomaticMemory,
  saveMemoriesViaIpc,
} from './auto-memory.js';

afterEach(() => {
  configureAutoMemory({
    enabled: true,
    importanceThreshold: 0.6,
    maxMemoriesPerSession: 10,
    saveUserFeedback: true,
    saveToolDiscoveries: true,
    saveWorkflowPatterns: true,
  });
});

function makeTempIpcDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-auto-memory-'));
}

describe('saveMemoriesViaIpc', () => {
  it('writes authenticated memory-save requests to the memory-requests IPC lane', () => {
    const ipcDir = makeTempIpcDir();

    const saved = saveMemoriesViaIpc(
      [
        {
          kind: 'lesson',
          key: 'error_learning_1',
          value: 'Do not claim success before memory IPC confirms persistence.',
          confidence: 0.8,
        },
      ],
      'session/with spaces',
      ipcDir,
      {
        authToken: 'test-auth-token',
        groupFolder: 'team-alpha',
      },
    );

    expect(saved).toBe(1);

    const memoryRequestsDir = path.join(ipcDir, 'memory-requests');
    const files = fs.readdirSync(memoryRequestsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^mem-auto-.*\.json$/);

    const payload = JSON.parse(
      fs.readFileSync(path.join(memoryRequestsDir, files[0]), 'utf-8'),
    ) as {
      requestId: string;
      action: string;
      authToken?: string;
      payload: Record<string, unknown>;
    };

    expect(payload.requestId).toMatch(/^mem-auto-/);
    expect(payload.action).toBe('memory_save');
    expect(payload.authToken).toBe('test-auth-token');
    expect(payload.payload.kind).toBe('correction');
    expect(payload.payload.group_folder).toBe('team-alpha');
    expect(payload.payload.source).toBe('auto_memory_session-with-spaces');
    expect(fs.existsSync(path.join(ipcDir, 'input'))).toBe(false);
  });
});

describe('processAutomaticMemory', () => {
  it('returns the number of persisted requests for a high-priority conversation', () => {
    const ipcDir = makeTempIpcDir();

    const result = processAutomaticMemory(
      {
        userMessage:
          'This workflow should always use the approved integration setup.',
        sessionId: 'session-123',
        timestamp: new Date().toISOString(),
        hasErrors: false,
      },
      'session-123',
      ipcDir,
      {
        authToken: 'test-auth-token',
        groupFolder: 'team-alpha',
      },
    );

    expect(result.processed).toBe(2);
    expect(result.saved).toBe(2);
    expect(result.skipped).toBe('');

    const files = fs.readdirSync(path.join(ipcDir, 'memory-requests'));
    expect(files).toHaveLength(2);
  });

  it('skips low-priority conversations without writing IPC files', () => {
    const ipcDir = makeTempIpcDir();
    configureAutoMemory({ importanceThreshold: 0.95 });

    const result = processAutomaticMemory(
      {
        userMessage: 'hello there',
        sessionId: 'session-456',
        timestamp: new Date().toISOString(),
        hasErrors: false,
      },
      'session-456',
      ipcDir,
    );

    expect(result.saved).toBe(0);
    expect(result.skipped).toContain('Priority too low');
    expect(fs.existsSync(path.join(ipcDir, 'memory-requests'))).toBe(false);
  });
});
