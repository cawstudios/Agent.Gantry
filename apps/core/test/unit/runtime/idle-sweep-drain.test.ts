import { describe, expect, it } from 'vitest';

import {
  drainBatches,
  mapWithConcurrency,
} from '@core/runtime/idle-sweep-drain.js';

describe('mapWithConcurrency', () => {
  it('runs at most `limit` tasks at once and processes every item', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const done: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      done.push(n);
    });
    expect(maxInFlight).toBe(3); // never sequential (1), never unbounded (7)
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('drainBatches — adaptive drain', () => {
  it('drains consecutive FULL batches and stops on the first partial batch', async () => {
    // batchSize 2: [full, full, partial] -> should fetch 3 times, process all 5.
    const batches = [[1, 2], [3, 4], [5]];
    let fetches = 0;
    const processed: number[] = [];
    const total = await drainBatches({
      fetchBatch: async () => batches[fetches++] ?? [],
      processItem: async (n) => {
        processed.push(n);
      },
      batchSize: 2,
      concurrency: 2,
    });
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(total).toBe(5);
    expect(fetches).toBe(3); // two full batches => keep draining; partial => stop
  });

  it('does no work and fetches once when the first batch is empty', async () => {
    let fetches = 0;
    const total = await drainBatches({
      fetchBatch: async () => {
        fetches += 1;
        return [];
      },
      processItem: async () => {
        throw new Error('processItem must not run on an empty batch');
      },
      batchSize: 2,
      concurrency: 2,
    });
    expect(total).toBe(0);
    expect(fetches).toBe(1);
  });
});
