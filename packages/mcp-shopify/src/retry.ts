import { ShopifyAdapterError } from './errors.js';

export interface BackoffOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterMs?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_CODES = new Set([
  'RATE_LIMITED',
  'UNAVAILABLE',
  'TIMEOUT',
  'NETWORK_ERROR',
]);

export function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof ShopifyAdapterError) return RETRYABLE_CODES.has(err.code);
  return false;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions,
): Promise<T> {
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const sleep = opts.sleep ?? defaultSleep;
  const jitter = opts.jitterMs ?? 100;

  let attempt = 0;
  let lastErr: unknown;

  while (attempt < opts.maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt >= opts.maxAttempts;
      if (isLast || !shouldRetry(err, attempt)) throw err;

      let delay = Math.min(
        opts.initialDelayMs * 2 ** (attempt - 1),
        opts.maxDelayMs,
      );

      if (err instanceof ShopifyAdapterError && err.code === 'RATE_LIMITED') {
        const retryAfter = err.details?.['retryAfterMs'];
        if (typeof retryAfter === 'number' && retryAfter > 0) {
          delay = Math.min(retryAfter, opts.maxDelayMs);
        }
      }

      if (jitter > 0) delay += Math.floor(Math.random() * jitter);
      await sleep(delay);
    }
  }

  throw lastErr;
}
