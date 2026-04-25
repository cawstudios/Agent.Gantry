import { describe, expect, it, vi } from 'vitest';
import { logger } from '@core/infrastructure/logging/logger.js';
import {
  PartialMessageDeliveryError,
  sendWithPartialDeliveryGuard,
} from '@core/runtime/partial-delivery.js';

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

describe('sendWithPartialDeliveryGuard', () => {
  it('marks partial delivery as sent and logs only sanitized metadata', async () => {
    const cause = Object.assign(new Error('provider token leaked'), {
      token: 'SECRET_TOKEN',
    });
    const err = new PartialMessageDeliveryError({
      cause,
      deliveredChunks: 1,
      message: 'message partially delivered',
      name: 'PartialTelegramDeliveryError',
      totalChunks: 2,
    });

    await expect(
      sendWithPartialDeliveryGuard(() => Promise.reject(err), {
        group: 'team',
      }),
    ).resolves.toBe(true);

    expect(logger.warn).toHaveBeenCalledWith(
      {
        group: 'team',
        error: {
          name: 'PartialTelegramDeliveryError',
          message: 'message partially delivered',
          deliveredChunks: 1,
          totalChunks: 2,
        },
      },
      'Message delivery partially succeeded; marking output delivered to prevent duplicate retry',
    );
    const loggedPayload = vi.mocked(logger.warn).mock.calls[0][0];
    expect(JSON.stringify(loggedPayload)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(loggedPayload)).not.toContain(
      'provider token leaked',
    );
  });

  it('rethrows non-partial delivery failures', async () => {
    const err = new Error('network unavailable');

    await expect(
      sendWithPartialDeliveryGuard(() => Promise.reject(err), {
        group: 'team',
      }),
    ).rejects.toBe(err);
  });

  it('rethrows structurally forged partial delivery flags', async () => {
    const err = Object.assign(new Error('forged partial delivery'), {
      partialMessageDelivery: true,
      deliveredChunks: 1,
      totalChunks: 2,
    });

    await expect(
      sendWithPartialDeliveryGuard(() => Promise.reject(err), {
        group: 'team',
      }),
    ).rejects.toBe(err);
  });

  it('rethrows branded partial delivery errors without delivered chunks', async () => {
    const err = new PartialMessageDeliveryError({
      cause: new Error('provider failure before visible output'),
      deliveredChunks: 0,
      message: 'no chunks delivered',
      name: 'PartialTelegramDeliveryError',
      totalChunks: 2,
    });

    await expect(
      sendWithPartialDeliveryGuard(() => Promise.reject(err), {
        group: 'team',
      }),
    ).rejects.toBe(err);
  });
});
