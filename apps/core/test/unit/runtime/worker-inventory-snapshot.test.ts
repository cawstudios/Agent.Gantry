import { describe, expect, it } from 'vitest';
import {
  summarizeWorkerInventorySnapshots,
  type WorkerInventorySnapshot,
} from '@core/runtime/worker-inventory-snapshot.js';

const BASE_SNAPSHOT: WorkerInventorySnapshot = {
  instanceId: 'local-dev',
  hostname: 'developer-machine',
  startedAt: '2026-06-17T12:00:00.000Z',
  lastHeartbeatAt: '2026-06-17T12:30:00.000Z',
  warmPool: {
    availableTarget: 3,
    genericAvailable: 3,
    genericStarting: 0,
    boundActive: 2,
    boundIdle: 1,
    boundDraining: 0,
    cachePrewarm: {
      pending: 0,
      succeeded: 2,
      skipped: 1,
      failed: 0,
    },
    cacheShapes: [
      {
        cacheShapeKey: 'shape:catalog',
        status: 'skipped',
        workers: 1,
      },
      {
        cacheShapeKey: 'shape:catalog',
        status: 'succeeded',
        workers: 2,
      },
    ],
  },
  queue: {
    activeMessageRuns: 2,
    pendingConversationKeys: 4,
    maxMessageRuns: 3,
  },
};

describe('worker inventory snapshots', () => {
  it('keeps a single local instance row shaped for the admin dashboard', () => {
    const summary = summarizeWorkerInventorySnapshots({
      snapshots: [BASE_SNAPSHOT],
      now: new Date('2026-06-17T12:30:05.000Z'),
      staleAfterMs: 30_000,
    });

    expect(summary.instances).toEqual([
      {
        ...BASE_SNAPSHOT,
        health: 'healthy',
      },
    ]);
    expect(summary.healthyTotals).toEqual({
      instances: 1,
      warmPool: BASE_SNAPSHOT.warmPool,
      queue: BASE_SNAPSHOT.queue,
    });
  });

  it('marks stale rows and excludes them from healthy aggregate totals', () => {
    const stale: WorkerInventorySnapshot = {
      ...BASE_SNAPSHOT,
      instanceId: 'server-b',
      lastHeartbeatAt: '2026-06-17T12:29:00.000Z',
      warmPool: {
        ...BASE_SNAPSHOT.warmPool,
        genericAvailable: 99,
      },
      queue: {
        ...BASE_SNAPSHOT.queue,
        activeMessageRuns: 99,
      },
    };

    const summary = summarizeWorkerInventorySnapshots({
      snapshots: [BASE_SNAPSHOT, stale],
      now: new Date('2026-06-17T12:30:05.000Z'),
      staleAfterMs: 30_000,
    });

    expect(summary.instances.map((instance) => instance.health)).toEqual([
      'healthy',
      'stale',
    ]);
    expect(summary.healthyTotals).toEqual({
      instances: 1,
      warmPool: BASE_SNAPSHOT.warmPool,
      queue: BASE_SNAPSHOT.queue,
    });
  });

  it('aggregates cache prewarm visibility across healthy instances', () => {
    const secondHealthy: WorkerInventorySnapshot = {
      ...BASE_SNAPSHOT,
      instanceId: 'server-b',
      warmPool: {
        ...BASE_SNAPSHOT.warmPool,
        cachePrewarm: {
          pending: 1,
          succeeded: 1,
          skipped: 0,
          failed: 1,
        },
        cacheShapes: [
          {
            cacheShapeKey: 'shape:catalog',
            status: 'succeeded',
            workers: 1,
          },
          {
            cacheShapeKey: 'shape:other',
            status: 'failed',
            workers: 1,
          },
          {
            cacheShapeKey: 'shape:other',
            status: 'pending',
            workers: 1,
          },
        ],
      },
    };

    const summary = summarizeWorkerInventorySnapshots({
      snapshots: [BASE_SNAPSHOT, secondHealthy],
      now: new Date('2026-06-17T12:30:05.000Z'),
      staleAfterMs: 30_000,
    });

    expect(summary.healthyTotals.warmPool.cachePrewarm).toEqual({
      pending: 1,
      succeeded: 3,
      skipped: 1,
      failed: 1,
    });
    expect(summary.healthyTotals.warmPool.cacheShapes).toEqual([
      {
        cacheShapeKey: 'shape:catalog',
        status: 'skipped',
        workers: 1,
      },
      {
        cacheShapeKey: 'shape:catalog',
        status: 'succeeded',
        workers: 3,
      },
      {
        cacheShapeKey: 'shape:other',
        status: 'failed',
        workers: 1,
      },
      {
        cacheShapeKey: 'shape:other',
        status: 'pending',
        workers: 1,
      },
    ]);
  });
});
