export const TRIGGER_RATE_WINDOW_MS = 60_000;
export const TRIGGER_RATE_LIMIT_PER_APP = 120;
export const TRIGGER_RATE_LIMIT_PER_JOB = 20;

export type RateLimiter = {
  consume: (key: string, limit: number) => boolean;
};

export function createRateLimiter(
  windowMs = TRIGGER_RATE_WINDOW_MS,
): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    consume(key, limit) {
      const now = Date.now();
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
      const current = buckets.get(key);
      if (!current || current.resetAt <= now) {
        buckets.set(key, {
          count: 1,
          resetAt: now + windowMs,
        });
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    },
  };
}
