import { describe, expect, it } from 'vitest';
import { withExponentialBackoff } from '../../src/retry.js';
import { ShopifyAdapterError } from '../../src/errors.js';

describe('withExponentialBackoff', () => {
  it('returns immediately on success', async () => {
    let attempts = 0;
    const result = await withExponentialBackoff(
      async () => {
        attempts += 1;
        return 'ok';
      },
      { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4, sleep: async () => {} },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(1);
  });

  it('retries retryable Shopify errors then succeeds', async () => {
    let attempts = 0;
    const result = await withExponentialBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new ShopifyAdapterError('UNAVAILABLE', 'shopify down');
        }
        return 'recovered';
      },
      { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 4, sleep: async () => {} },
    );
    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
  });

  it('honors Retry-After hint on RATE_LIMITED', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await expect(
      withExponentialBackoff(
        async () => {
          attempts += 1;
          throw new ShopifyAdapterError('RATE_LIMITED', 'rate limited', {
            retryAfterMs: 250,
          });
        },
        {
          maxAttempts: 2,
          initialDelayMs: 10,
          maxDelayMs: 1000,
          jitterMs: 0,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toBeInstanceOf(ShopifyAdapterError);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it('does not retry non-retryable codes', async () => {
    let attempts = 0;
    await expect(
      withExponentialBackoff(
        async () => {
          attempts += 1;
          throw new ShopifyAdapterError('PRIVACY_GUARD_FAILED', 'no');
        },
        {
          maxAttempts: 5,
          initialDelayMs: 1,
          maxDelayMs: 4,
          sleep: async () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'PRIVACY_GUARD_FAILED' });
    expect(attempts).toBe(1);
  });

  it('caps attempts at maxAttempts', async () => {
    let attempts = 0;
    await expect(
      withExponentialBackoff(
        async () => {
          attempts += 1;
          throw new ShopifyAdapterError('TIMEOUT', 'timeout');
        },
        { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(attempts).toBe(3);
  });
});
