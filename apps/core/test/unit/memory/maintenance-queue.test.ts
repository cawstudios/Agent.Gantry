import { describe, expect, it } from 'vitest';

import { MemoryMaintenanceQueue } from '@core/memory/maintenance-queue.js';

describe('MemoryMaintenanceQueue', () => {
  it('dedupes only matching dedupe keys', async () => {
    const queue = new MemoryMaintenanceQueue({ maxPending: 10 });

    let releaseFirst: (() => void) | null = null;
    const firstTask = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueueDetailed(
      'team',
      async () => {
        await firstTask;
      },
      'dream:team',
    );
    const deduped = queue.enqueueDetailed('team', async () => {}, 'dream:team');
    const differentKey = queue.enqueueDetailed(
      'team',
      async () => {},
      'cleanup:team',
    );

    expect(first).toEqual({ queued: true, deduped: false, reason: 'queued' });
    expect(deduped).toEqual({
      queued: false,
      deduped: true,
      reason: 'deduped',
    });
    expect(differentKey).toEqual({
      queued: true,
      deduped: false,
      reason: 'queued',
    });

    releaseFirst?.();
    await queue.enqueueAndWait('team', async () => {}, 'final:team');
  });

  it('tracks running status per group even with keyed dedupe', async () => {
    const queue = new MemoryMaintenanceQueue({ maxPending: 10 });
    let unblock: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    const runPromise = queue.enqueueAndWait(
      'team',
      async () => {
        await gate;
      },
      'dream:team',
    );

    expect(queue.isRunningForGroup('team')).toBe(true);

    unblock?.();
    await runPromise;
    expect(queue.isRunningForGroup('team')).toBe(false);
  });

  it('removes a waiting task when its signal is aborted', async () => {
    const queue = new MemoryMaintenanceQueue({ maxPending: 10 });
    let unblock: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const controller = new AbortController();
    const waitingTask = async () => {
      throw new Error('aborted queued task should not run');
    };

    const running = queue.enqueueAndWait(
      'team',
      async () => {
        await gate;
      },
      'dream:team',
    );
    const waiting = queue.enqueueAndWait('team', waitingTask, 'cleanup:team', {
      signal: controller.signal,
    });

    expect(queue.getPendingCount()).toBe(1);
    controller.abort(new Error('memory dreaming job deadline exceeded'));
    await expect(waiting).rejects.toThrow(
      'memory dreaming job deadline exceeded',
    );
    expect(queue.getPendingCount()).toBe(0);

    unblock?.();
    await running;
  });
});
