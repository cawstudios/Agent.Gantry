import type { WarmPoolRuntime } from './agent-spawn-types.js';

export interface WarmPoolMaintenanceHandle {
  close(): void;
}

export interface WarmPoolMaintenanceLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface WarmPoolMaintenanceOptions {
  warmPool?: WarmPoolRuntime;
  idleTtlMs: number;
  intervalMs?: number;
  logger: WarmPoolMaintenanceLogger;
}

function maintenanceIntervalMs(idleTtlMs: number): number {
  return Math.max(1_000, Math.min(60_000, Math.floor(idleTtlMs / 4)));
}

export function startWarmPoolMaintenance(
  options: WarmPoolMaintenanceOptions,
): WarmPoolMaintenanceHandle {
  const { warmPool, idleTtlMs, logger } = options;
  if (!warmPool?.healthCheck && !warmPool?.evictIdle) {
    return { close: () => {} };
  }
  const interval = setInterval(
    () => {
      void (async () => {
        await warmPool.healthCheck?.();
        await warmPool.evictIdle?.(idleTtlMs);
      })().catch((err) => {
        logger.warn({ err }, 'Warm-pool maintenance tick failed');
      });
    },
    options.intervalMs ?? maintenanceIntervalMs(idleTtlMs),
  );
  interval.unref?.();
  return {
    close: () => clearInterval(interval),
  };
}
