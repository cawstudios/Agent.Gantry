import { describe, expect, it, vi } from 'vitest';

import { RepositoryRuntimeSecretProvider } from '@core/adapters/credentials/repository-runtime-secret-provider.js';
import type { CapabilitySecretRepository } from '@core/domain/ports/repositories.js';

describe('RepositoryRuntimeSecretProvider', () => {
  it('resolves Gantry-managed secrets from the encrypted secret repository', async () => {
    const repository = {
      getSecret: vi.fn(async () => ({ value: 'xoxb-secret' })),
    } as unknown as CapabilitySecretRepository;
    const provider = new RepositoryRuntimeSecretProvider({
      appId: 'default' as never,
      repository,
      fallback: {
        getSecret: vi.fn(),
        getOptionalSecret: vi.fn(),
      },
    });

    await expect(
      provider.getOptionalSecretAsync?.({
        ref: 'gantry-secret:SLACK_BOT_TOKEN',
      }),
    ).resolves.toBe('xoxb-secret');
    expect(repository.getSecret).toHaveBeenCalledWith({
      appId: 'default',
      name: 'SLACK_BOT_TOKEN',
    });
  });

  it('delegates env and aws refs to the fallback provider', async () => {
    const fallback = {
      getSecret: vi.fn(),
      getOptionalSecret: vi.fn(() => undefined),
      getOptionalSecretAsync: vi.fn(async () => 'external-secret'),
    };
    const provider = new RepositoryRuntimeSecretProvider({
      appId: 'default' as never,
      repository: {
        getSecret: vi.fn(),
      } as unknown as CapabilitySecretRepository,
      fallback,
    });

    await expect(
      provider.getOptionalSecretAsync?.({ ref: 'aws-sm:/gantry/slack/bot' }),
    ).resolves.toBe('external-secret');
    expect(fallback.getOptionalSecretAsync).toHaveBeenCalledWith({
      ref: 'aws-sm:/gantry/slack/bot',
    });
  });
});
