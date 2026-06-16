import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startWarmPoolMaintenance } from '@core/runtime/warm-pool-maintenance.js';
import type { WarmPoolRuntime } from '@core/runtime/agent-spawn-types.js';

describe('startWarmPoolMaintenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('periodically health-checks and evicts idle warm workers', async () => {
    const warmPool: WarmPoolRuntime = {
      acquire: vi.fn(() => null),
      healthCheck: vi.fn(async () => undefined),
      evictIdle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const warn = vi.fn();

    const handle = startWarmPoolMaintenance({
      warmPool,
      idleTtlMs: 4_000,
      logger: { warn },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(warmPool.healthCheck).toHaveBeenCalledOnce();
    expect(warmPool.evictIdle).toHaveBeenCalledWith(4_000);
    expect(warn).not.toHaveBeenCalled();

    handle.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warmPool.healthCheck).toHaveBeenCalledOnce();
  });

  it('is a no-op when the runtime has no maintenance-capable pool', async () => {
    const handle = startWarmPoolMaintenance({
      idleTtlMs: 4_000,
      logger: { warn: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(5_000);

    handle.close();
  });
});
