import { describe, expect, it, vi } from 'vitest';

import {
  _testAppMemory,
  AppMemoryService,
} from '@core/memory/app-memory-service.js';

describe('app-grade memory boundaries', () => {
  it('normalizes personal defaults without relying on storage providers', () => {
    const context = _testAppMemory.normalizeSubject({});

    expect(context).toMatchObject({
      appId: 'personal',
      agentId: 'main',
      subjectType: 'group',
      subjectId: 'default',
    });
  });

  it('uses channel boundaries when channel context is present', () => {
    const context = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'support-agent',
      userId: 'user-1',
      groupId: 'workspace-1',
      channelId: 'sl:C123',
      threadId: 'thread-1',
    });

    expect(context).toMatchObject({
      appId: 'app-a',
      agentId: 'support-agent',
      subjectType: 'channel',
      subjectId: 'sl:C123',
      userId: 'user-1',
      groupId: 'workspace-1',
      channelId: 'sl:C123',
      threadId: 'thread-1',
    });
  });

  it('keeps common memory as an explicit app subject', () => {
    const context = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'support-agent',
      subjectType: 'common',
    });

    expect(context).toMatchObject({
      appId: 'app-a',
      agentId: 'support-agent',
      subjectType: 'common',
      subjectId: 'common',
    });
  });

  it('rejects invalid boundary identifiers', () => {
    expect(() =>
      _testAppMemory.normalizeSubject({
        appId: '../bad',
        agentId: 'agent',
      }),
    ).toThrow(/Invalid memory id/);
  });

  it('matches owned rows only inside the same normalized subject boundary', () => {
    const context = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
      channelId: 'sl:C123',
      threadId: 'thread-1',
    });
    const row = {
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'channel',
      subjectId: 'sl:C123',
      threadIdCanonical: 'thread-1',
    };

    expect(_testAppMemory.itemMatchesSubjectBoundary(row, context)).toBe(true);
    expect(
      _testAppMemory.itemMatchesSubjectBoundary(
        { ...row, subjectId: 'sl:C999' },
        context,
      ),
    ).toBe(false);
    expect(
      _testAppMemory.itemMatchesSubjectBoundary(
        { ...row, agentId: 'agent-b' },
        context,
      ),
    ).toBe(false);
  });

  it('allows broad memories in threaded contexts but blocks threaded rows from broad patch/delete contexts', () => {
    const threadedContext = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
      threadId: 'thread-1',
    });
    const broadContext = _testAppMemory.normalizeSubject({
      appId: 'app-a',
      agentId: 'agent-a',
      groupId: 'group-a',
    });
    const broadRow = {
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'group',
      subjectId: 'group-a',
      threadIdCanonical: null,
    };
    const threadedRow = {
      ...broadRow,
      threadIdCanonical: 'thread-1',
    };

    expect(
      _testAppMemory.itemMatchesSubjectBoundary(broadRow, threadedContext),
    ).toBe(true);
    expect(
      _testAppMemory.itemMatchesSubjectBoundary(threadedRow, broadContext),
    ).toBe(false);
  });

  it('rejects non-admin patches to common memory', async () => {
    const commonRow = {
      id: 'mem_common',
      appId: 'app-a',
      agentId: 'agent-a',
      subjectType: 'common',
      subjectId: 'common',
      threadIdCanonical: null,
      version: 1,
      isDeleted: false,
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [commonRow]),
          })),
        })),
      })),
      update: vi.fn(),
    };
    const service = new AppMemoryService(db as any);

    await expect(
      service.patch({
        id: 'mem_common',
        appId: 'app-a',
        agentId: 'agent-a',
        subjectType: 'common',
        subjectId: 'common',
        value: 'changed',
      }),
    ).rejects.toThrow(/common memory patches require admin/);
    expect(db.update).not.toHaveBeenCalled();
  });
});
