import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsPromisesMock = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  default: {
    promises: fsPromisesMock,
  },
}));

vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    randomUUID: vi.fn(() => 'snapshot-uuid'),
  };
});

vi.mock('@core/platform/group-folder.js', () => ({
  resolveGroupIpcPath: vi.fn((folder: string) => `/mock/ipc/${folder}`),
}));

import fs from 'fs';
import { resolveGroupIpcPath } from '@core/platform/group-folder.js';
import {
  clearSnapshotWriteCacheForTests,
  writeJobEventsSnapshot,
  writeJobsSnapshot,
  writeJobRunsSnapshot,
  writeGroupsSnapshot,
} from '@core/runtime/agent-spawn-snapshots.js';
import type {
  AvailableGroup,
  JobEventSnapshotRow,
  JobRunSnapshotRow,
  JobSnapshotRow,
} from '@core/runtime/agent-spawn-types.js';

function makeJob(overrides: Partial<JobSnapshotRow> = {}): JobSnapshotRow {
  return {
    id: 'job-1',
    name: 'Test Job',
    prompt: 'do stuff',
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    status: 'active',
    group_scope: 'group-a',
    linked_sessions: [],
    thread_id: null,
    next_run: null,
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    silent: false,
    cleanup_after_ms: 86400000,
    timeout_ms: 30000,
    max_retries: 3,
    retry_backoff_ms: 1000,
    max_consecutive_failures: 5,
    consecutive_failures: 0,
    execution_mode: 'parallel',
    pause_reason: null,
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<JobRunSnapshotRow> = {},
): JobRunSnapshotRow {
  return {
    run_id: 'run-1',
    job_id: 'job-1',
    scheduled_for: '2026-01-01T01:00:00Z',
    started_at: '2026-01-01T01:00:01Z',
    ended_at: null,
    status: 'running',
    result_summary: null,
    error_summary: null,
    retry_count: 0,
    notified_at: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<AvailableGroup> = {}): AvailableGroup {
  return {
    jid: 'jid-1',
    name: 'Group Alpha',
    lastActivity: '2026-01-01T00:00:00Z',
    isRegistered: true,
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<JobEventSnapshotRow> = {},
): JobEventSnapshotRow {
  return {
    id: 1,
    job_id: 'job-1',
    run_id: 'run-1',
    event_type: 'job.started',
    payload: null,
    created_at: '2026-01-01T01:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSnapshotWriteCacheForTests();
  fsPromisesMock.readFile.mockRejectedValue({ code: 'ENOENT' });
});

// --- writeJobsSnapshot ---

describe('writeJobsSnapshot', () => {
  it('creates the IPC directory', async () => {
    await writeJobsSnapshot('group-a', true, []);

    expect(resolveGroupIpcPath).toHaveBeenCalledWith('group-a');
    expect(fs.promises.mkdir).toHaveBeenCalledWith('/mock/ipc/group-a', {
      recursive: true,
    });
  });

  it('writes all jobs when isMain is true', async () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-b' }),
    ];

    await writeJobsSnapshot('group-a', true, jobs);

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_jobs.json.'),
      JSON.stringify(jobs, null, 2),
      'utf-8',
    );
    expect(fs.promises.rename).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_jobs.json.'),
      '/mock/ipc/group-a/current_jobs.json',
    );
  });

  it('writes only matching group_scope jobs when isMain is false', async () => {
    const jobA = makeJob({ id: 'j1', group_scope: 'group-a' });
    const jobB = makeJob({ id: 'j2', group_scope: 'group-b' });

    await writeJobsSnapshot('group-a', false, [jobA, jobB]);

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_jobs.json.'),
      JSON.stringify([jobA], null, 2),
      'utf-8',
    );
  });

  it('writes an empty array when isMain is false and no jobs match', async () => {
    const jobB = makeJob({ id: 'j1', group_scope: 'group-b' });

    await writeJobsSnapshot('group-a', false, [jobB]);

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_jobs.json.'),
      JSON.stringify([], null, 2),
      'utf-8',
    );
  });
});

// --- writeJobRunsSnapshot ---

describe('writeJobRunsSnapshot', () => {
  it('creates the IPC directory', async () => {
    await writeJobRunsSnapshot('group-a', true, [], []);

    expect(resolveGroupIpcPath).toHaveBeenCalledWith('group-a');
    expect(fs.promises.mkdir).toHaveBeenCalledWith('/mock/ipc/group-a', {
      recursive: true,
    });
  });

  it('writes all runs when isMain is true', async () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-b' }),
    ];
    const runs = [
      makeRun({ run_id: 'r1', job_id: 'j1' }),
      makeRun({ run_id: 'r2', job_id: 'j2' }),
    ];

    await writeJobRunsSnapshot('group-a', true, runs, jobs);

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_job_runs.json.'),
      JSON.stringify(runs, null, 2),
      'utf-8',
    );
  });

  it('writes only runs belonging to matching jobs when isMain is false', async () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-b' }),
    ];
    const runA = makeRun({ run_id: 'r1', job_id: 'j1' });
    const runB = makeRun({ run_id: 'r2', job_id: 'j2' });

    await writeJobRunsSnapshot('group-a', false, [runA, runB], jobs);

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_job_runs.json.'),
      JSON.stringify([runA], null, 2),
      'utf-8',
    );
  });

  it('writes empty array when isMain is false and no jobs match the group', async () => {
    const jobs = [makeJob({ id: 'j1', group_scope: 'group-b' })];
    const run = makeRun({ run_id: 'r1', job_id: 'j1' });

    await writeJobRunsSnapshot('group-a', false, [run], jobs);

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_job_runs.json.'),
      JSON.stringify([], null, 2),
      'utf-8',
    );
  });

  it('includes runs for multiple matching jobs when isMain is false', async () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-a' }),
      makeJob({ id: 'j3', group_scope: 'group-b' }),
    ];
    const r1 = makeRun({ run_id: 'r1', job_id: 'j1' });
    const r2 = makeRun({ run_id: 'r2', job_id: 'j2' });
    const r3 = makeRun({ run_id: 'r3', job_id: 'j3' });

    await writeJobRunsSnapshot('group-a', false, [r1, r2, r3], jobs);

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_job_runs.json.'),
      JSON.stringify([r1, r2], null, 2),
      'utf-8',
    );
  });
});

// --- writeJobEventsSnapshot ---

describe('writeJobEventsSnapshot', () => {
  it('writes all events when isMain is true', async () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-b' }),
    ];
    const events = [
      makeEvent({ id: 1, job_id: 'j1' }),
      makeEvent({ id: 2, job_id: 'j2' }),
    ];

    await writeJobEventsSnapshot('group-a', true, events, jobs);

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_job_events.json.'),
      JSON.stringify(events, null, 2),
      'utf-8',
    );
  });

  it('filters events by group jobs when isMain is false', async () => {
    const jobs = [
      makeJob({ id: 'j1', group_scope: 'group-a' }),
      makeJob({ id: 'j2', group_scope: 'group-b' }),
    ];
    const eventA = makeEvent({ id: 1, job_id: 'j1' });
    const eventB = makeEvent({ id: 2, job_id: 'j2' });

    await writeJobEventsSnapshot('group-a', false, [eventA, eventB], jobs);

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.current_job_events.json.'),
      JSON.stringify([eventA], null, 2),
      'utf-8',
    );
  });
});

// --- writeGroupsSnapshot ---

describe('writeGroupsSnapshot', () => {
  it('creates the IPC directory', async () => {
    await writeGroupsSnapshot('group-a', true, [], new Set());

    expect(resolveGroupIpcPath).toHaveBeenCalledWith('group-a');
    expect(fs.promises.mkdir).toHaveBeenCalledWith('/mock/ipc/group-a', {
      recursive: true,
    });
  });

  it('writes all groups when isMain is true', async () => {
    const groups = [
      makeGroup({ jid: 'jid-1', name: 'Alpha' }),
      makeGroup({ jid: 'jid-2', name: 'Beta' }),
    ];

    await writeGroupsSnapshot('group-a', true, groups, new Set(['jid-1']));

    const written = JSON.parse(
      (fs.promises.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1],
    );
    expect(written.groups).toEqual(groups);
    expect(written.lastSync).toBeDefined();
    expect(typeof written.lastSync).toBe('string');
  });

  it('writes empty groups array when isMain is false', async () => {
    const groups = [makeGroup({ jid: 'jid-1', name: 'Alpha' })];

    await writeGroupsSnapshot('group-a', false, groups, new Set(['jid-1']));

    const written = JSON.parse(
      (fs.promises.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1],
    );
    expect(written.groups).toEqual([]);
  });

  it('always includes a lastSync ISO timestamp', async () => {
    const before = new Date().toISOString();

    await writeGroupsSnapshot('group-a', false, [], new Set());

    const written = JSON.parse(
      (fs.promises.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1],
    );
    const after = new Date().toISOString();

    expect(written.lastSync).toBeDefined();
    expect(written.lastSync >= before).toBe(true);
    expect(written.lastSync <= after).toBe(true);
  });

  it('writes to the correct file path', async () => {
    await writeGroupsSnapshot('group-a', true, [], new Set());

    expect(fs.promises.rename).toHaveBeenCalledWith(
      expect.stringContaining('/mock/ipc/group-a/.available_groups.json.'),
      '/mock/ipc/group-a/available_groups.json',
    );
  });
});
