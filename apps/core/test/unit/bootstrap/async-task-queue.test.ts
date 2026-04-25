import { describe, expect, it } from 'vitest';

import { AsyncTaskQueue } from '@core/app/bootstrap/async-task-queue.js';

describe('AsyncTaskQueue', () => {
  it('acknowledges admission without waiting for task completion', async () => {
    const queue = new AsyncTaskQueue(1, 10);
    let release!: () => void;

    expect(
      queue.enqueue(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    ).toBe(true);

    let idle = false;
    const idlePromise = queue.waitForIdle().then(() => {
      idle = true;
    });

    await Promise.resolve();
    expect(idle).toBe(false);

    release();
    await idlePromise;
    expect(idle).toBe(true);
  });

  it('rejects new work after the hard pending cap', async () => {
    const queue = new AsyncTaskQueue(1, 1, 2);
    let releaseFirst!: () => void;

    const first = queue.enqueue(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    let secondRan = false;
    const second = queue.enqueue(async () => {
      secondRan = true;
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(secondRan).toBe(false);

    releaseFirst();
    await queue.waitForIdle();

    expect(secondRan).toBe(false);
  });

  it('waits for capacity before admitting overflow work', async () => {
    const queue = new AsyncTaskQueue(1, 1, 2);
    let releaseFirst!: () => void;
    const events: string[] = [];

    expect(
      queue.enqueue(
        () =>
          new Promise<void>((resolve) => {
            events.push('first-started');
            releaseFirst = resolve;
          }),
      ),
    ).toBe(true);

    const admitted = queue.enqueueWhenAvailable(async () => {
      events.push('second-started');
    });

    await Promise.resolve();
    expect(events).toEqual(['first-started']);

    releaseFirst();
    await admitted;
    await queue.waitForIdle();

    expect(events).toEqual(['first-started', 'second-started']);
  });

  it('wakes only one overflow waiter for each freed slot', async () => {
    const queue = new AsyncTaskQueue(1, 1, 2);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;

    expect(
      queue.enqueue(
        () =>
          new Promise<void>((resolve) => {
            events.push('first-started');
            releaseFirst = resolve;
          }),
      ),
    ).toBe(true);

    const secondAdmitted = queue.enqueueWhenAvailable(
      () =>
        new Promise<void>((resolve) => {
          events.push('second-started');
          releaseSecond = resolve;
        }),
    );
    const thirdAdmitted = queue.enqueueWhenAvailable(async () => {
      events.push('third-started');
    });

    await Promise.resolve();
    expect(events).toEqual(['first-started']);

    releaseFirst();
    await secondAdmitted;
    await Promise.resolve();
    expect(events).toEqual(['first-started', 'second-started']);

    releaseSecond();
    await thirdAdmitted;
    await queue.waitForIdle();
    expect(events).toEqual([
      'first-started',
      'second-started',
      'third-started',
    ]);
  });

  it('does not drop overflow admission when multiple waiters are queued', async () => {
    const queue = new AsyncTaskQueue(1, 1, 1);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const events: string[] = [];

    expect(
      queue.enqueue(
        () =>
          new Promise<void>((resolve) => {
            events.push('first-started');
            releaseFirst = resolve;
          }),
      ),
    ).toBe(true);

    const secondAdmitted = queue.enqueueWhenAvailable(
      () =>
        new Promise<void>((resolve) => {
          events.push('second-started');
          releaseSecond = resolve;
        }),
    );
    const thirdAdmitted = queue.enqueueWhenAvailable(async () => {
      events.push('third-started');
    });

    releaseFirst();
    await expect(secondAdmitted).resolves.toBe(true);
    releaseSecond();
    await expect(thirdAdmitted).resolves.toBe(true);
    await queue.waitForIdle();

    expect(events).toEqual([
      'first-started',
      'second-started',
      'third-started',
    ]);
  });
});
