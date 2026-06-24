import { describe, expect, it, vi } from 'vitest';

import {
  DiscoverProviderConversationsService,
  ProviderConnectionControlService,
} from '@core/application/provider-conversations/provider-conversation-control-use-cases.js';
import { ApplicationError } from '@core/application/common/application-error.js';

const iso = '2026-05-02T00:00:00.000Z';

describe('ProviderConnectionControlService', () => {
  it('preserves null external refs when updating provider connections', async () => {
    const providerConnection = {
      id: 'providerConnection-1',
      appId: 'default',
      providerId: 'telegram',
      externalInstallationRef: {
        kind: 'provider_connection',
        value: 'stale-ref',
      },
      label: 'Telegram',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerConnections = {
      getProviderConnection: vi.fn(async () => providerConnection),
      updateProviderConnection: vi.fn(async () => ({
        ...providerConnection,
        externalInstallationRef: undefined,
      })),
    };
    const service = new ProviderConnectionControlService({
      providerConnections: providerConnections as never,
      providers: { listProviders: vi.fn(async () => []) },
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await service.update({
      appId: 'default' as never,
      providerConnectionId: 'providerConnection-1' as never,
      patch: { externalInstallationRef: null },
    });

    expect(providerConnections.updateProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ externalInstallationRef: null }),
      }),
    );
  });

  it('accepts AWS Secrets Manager runtime refs with deployment-owned names', async () => {
    const providerConnection = {
      id: 'providerConnection-1',
      appId: 'default',
      providerId: 'slack',
      externalInstallationRef: undefined,
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerConnections = {
      getProviderConnection: vi.fn(async () => providerConnection),
      updateProviderConnection: vi.fn(async () => providerConnection),
    };
    const service = new ProviderConnectionControlService({
      providerConnections: providerConnections as never,
      providers: {
        listProviders: vi.fn(async () => [
          {
            id: 'slack',
            displayName: 'Slack',
            allowedRuntimeSecretKeys: ['bot_token', 'app_token'],
          },
        ]),
      } as never,
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await service.update({
      appId: 'default' as never,
      providerConnectionId: 'providerConnection-1' as never,
      patch: {
        runtimeSecretRefs: { bot_token: 'aws-sm:prod/slack/bot' },
      },
    });

    expect(providerConnections.updateProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          runtimeSecretRefs: { bot_token: 'aws-sm:prod/slack/bot' },
        }),
      }),
    );
  });

  it('accepts custom env runtime refs for provider secret slots', async () => {
    const providerConnection = {
      id: 'providerConnection-1',
      appId: 'default',
      providerId: 'slack',
      externalInstallationRef: undefined,
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerConnections = {
      getProviderConnection: vi.fn(async () => providerConnection),
      updateProviderConnection: vi.fn(async () => providerConnection),
    };
    const service = new ProviderConnectionControlService({
      providerConnections: providerConnections as never,
      providers: {
        listProviders: vi.fn(async () => [
          {
            id: 'slack',
            displayName: 'Slack',
            allowedRuntimeSecretKeys: ['bot_token', 'app_token'],
          },
        ]),
      } as never,
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await service.update({
      appId: 'default' as never,
      providerConnectionId: 'providerConnection-1' as never,
      patch: {
        runtimeSecretRefs: { bot_token: 'env:CUSTOM_SLACK_BOT_TOKEN' },
      },
    });

    expect(providerConnections.updateProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          runtimeSecretRefs: { bot_token: 'env:CUSTOM_SLACK_BOT_TOKEN' },
        }),
      }),
    );
  });

  it('rejects forbidden env runtime refs before saving provider connections', async () => {
    const providerConnection = {
      id: 'providerConnection-1',
      appId: 'default',
      providerId: 'slack',
      externalInstallationRef: undefined,
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerConnections = {
      getProviderConnection: vi.fn(async () => providerConnection),
      updateProviderConnection: vi.fn(async () => providerConnection),
    };
    const service = new ProviderConnectionControlService({
      providerConnections: providerConnections as never,
      providers: {
        listProviders: vi.fn(async () => [
          {
            id: 'slack',
            displayName: 'Slack',
            allowedRuntimeSecretKeys: ['bot_token', 'app_token'],
          },
        ]),
      } as never,
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await expect(
      service.update({
        appId: 'default' as never,
        providerConnectionId: 'providerConnection-1' as never,
        patch: {
          runtimeSecretRefs: { bot_token: 'env:OPENAI_API_KEY' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('OPENAI_API_KEY is not allowed'),
    });
    expect(providerConnections.updateProviderConnection).not.toHaveBeenCalled();
  });

  it('rejects unrelated env runtime refs before saving provider connections', async () => {
    const providerConnection = {
      id: 'providerConnection-1',
      appId: 'default',
      providerId: 'slack',
      externalInstallationRef: undefined,
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      createdAt: iso,
      updatedAt: iso,
    };
    const providerConnections = {
      getProviderConnection: vi.fn(async () => providerConnection),
      updateProviderConnection: vi.fn(async () => providerConnection),
    };
    const service = new ProviderConnectionControlService({
      providerConnections: providerConnections as never,
      providers: {
        listProviders: vi.fn(async () => [
          {
            id: 'slack',
            displayName: 'Slack',
            allowedRuntimeSecretKeys: ['bot_token', 'app_token'],
          },
        ]),
      } as never,
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await expect(
      service.update({
        appId: 'default' as never,
        providerConnectionId: 'providerConnection-1' as never,
        patch: {
          runtimeSecretRefs: { bot_token: 'env:SECRET_ENCRYPTION_KEY' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining(
        'must point to the canonical slack credential for bot_token',
      ),
    });
    expect(providerConnections.updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe('DiscoverProviderConversationsService', () => {
  it('fails closed when discovered external ids use a mismatched explicit provider prefix', async () => {
    const service = new DiscoverProviderConversationsService({
      providerConnections: {
        getProviderConnection: vi.fn(async () => ({
          id: 'slack_default',
          appId: 'default',
          providerId: 'slack',
          label: 'Slack',
          status: 'active',
          config: {},
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
          createdAt: iso,
          updatedAt: iso,
        })),
      } as never,
      conversations: {
        getConversationByExternalRef: vi.fn(async () => null),
        saveConversation: vi.fn(async () => {}),
      } as never,
      discovery: {
        discover: vi.fn(async () => [
          {
            externalId: 'tg:-100123',
            kind: 'channel',
          },
        ]),
      },
      ids: { generate: vi.fn(() => 'id-1') },
      clock: { now: () => iso },
    });

    await expect(
      service.execute({
        appId: 'default' as never,
        providerConnectionId: 'slack_default' as never,
      }),
    ).rejects.toBeInstanceOf(ApplicationError);
    await expect(
      service.execute({
        appId: 'default' as never,
        providerConnectionId: 'slack_default' as never,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});
