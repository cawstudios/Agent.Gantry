export const MEMORY_DREAM_RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const MEMORY_DREAM_SYSTEM_JOB_TIMEOUT_MS =
  MEMORY_DREAM_RUN_TIMEOUT_MS + 60_000;
export const MEMORY_DREAM_SYSTEM_JOB_FINALIZATION_GRACE_MS = 60_000;
export const MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS = 30_000;

export class MemoryOperationTimeoutError extends Error {
  readonly code = 'MEMORY_OPERATION_TIMEOUT';

  constructor(message: string) {
    super(message);
    this.name = 'MemoryOperationTimeoutError';
  }
}

export function memoryDreamRunLeaseExpiresAt(
  startedAt: string,
  deadlineAtMs?: number,
): string {
  const startedAtMs = new Date(startedAt).getTime();
  const defaultExpiresAtMs = startedAtMs + MEMORY_DREAM_RUN_TIMEOUT_MS;
  const boundedExpiresAtMs =
    typeof deadlineAtMs === 'number' && Number.isFinite(deadlineAtMs)
      ? Math.min(defaultExpiresAtMs, Math.max(startedAtMs, deadlineAtMs))
      : defaultExpiresAtMs;
  return new Date(boundedExpiresAtMs).toISOString();
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('memory dreaming aborted');
}

export function isMemoryOperationTimeoutError(
  error: unknown,
): error is MemoryOperationTimeoutError {
  return (
    error instanceof MemoryOperationTimeoutError ||
    (error instanceof Error &&
      (error.name === 'MemoryOperationTimeoutError' ||
        error.message.includes('deadline exceeded')))
  );
}

export function normalizeMemoryTimeoutMs(
  value: number | null | undefined,
  fallbackMs: number,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  return Math.max(1, Math.floor(fallbackMs));
}

export function createMemoryOperationDeadline(input: {
  timeoutMs?: number;
  label: string;
  parentSignal?: AbortSignal;
  nowMs?: () => number;
}): {
  signal: AbortSignal;
  deadlineAtMs?: number;
  remainingTimeoutMs: () => number | undefined;
  throwIfExpired: () => void;
  dispose: () => void;
} {
  const nowMs = input.nowMs ?? (() => Date.now());
  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(1, Math.floor(input.timeoutMs))
      : undefined;
  const controller = new AbortController();
  const deadlineAtMs =
    timeoutMs === undefined ? undefined : nowMs() + timeoutMs;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const abortWith = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onParentAbort = () => {
    abortWith(abortReason(input.parentSignal!));
  };

  if (input.parentSignal?.aborted) {
    abortWith(abortReason(input.parentSignal));
  } else if (input.parentSignal) {
    input.parentSignal.addEventListener('abort', onParentAbort, {
      once: true,
    });
  }

  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      abortWith(
        new MemoryOperationTimeoutError(
          `${input.label} deadline exceeded after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    timeoutHandle.unref?.();
  }

  return {
    signal: controller.signal,
    deadlineAtMs,
    remainingTimeoutMs: () => {
      if (deadlineAtMs === undefined) return undefined;
      return deadlineAtMs - nowMs();
    },
    throwIfExpired: () => {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      if (deadlineAtMs !== undefined && deadlineAtMs <= nowMs()) {
        const error = new MemoryOperationTimeoutError(
          `${input.label} deadline exceeded after ${timeoutMs}ms`,
        );
        abortWith(error);
        throw error;
      }
    },
    dispose: () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      input.parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

export async function runWithMemoryOperationTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  input: {
    timeoutMs?: number;
    label: string;
    parentSignal?: AbortSignal;
  },
): Promise<T> {
  const deadline = createMemoryOperationDeadline(input);
  const operationPromise = operation(deadline.signal);
  operationPromise.catch(() => {
    // Prevent unhandled rejection noise when a deadline wins first.
  });
  const abortPromise = new Promise<T>((_, reject) => {
    if (deadline.signal.aborted) {
      reject(abortReason(deadline.signal));
      return;
    }
    deadline.signal.addEventListener(
      'abort',
      () => reject(abortReason(deadline.signal)),
      { once: true },
    );
  });
  try {
    return await Promise.race([operationPromise, abortPromise]);
  } finally {
    deadline.dispose();
  }
}
