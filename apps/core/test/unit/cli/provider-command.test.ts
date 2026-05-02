import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/channels/provider-registry.js');
  vi.doUnmock('@core/channels/register-builtins.js');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  vi.doUnmock('@core/config/env/file.js');
  vi.doUnmock('@core/config/settings/runtime-home.js');
  vi.doUnmock('@core/cli/provider-connect.js');
  vi.doUnmock('@core/cli/doctor.js');
  vi.doUnmock('@core/adapters/storage/postgres/runtime-store.js');
  vi.doUnmock('@clack/prompts');
});

function mockClack() {
  const note = vi.fn();
  const error = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    note,
    isCancel: () => false,
    log: { error, info: vi.fn(), warn: vi.fn() },
    select: vi.fn(),
    text: vi.fn(),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    })),
  }));
  return { note, error };
}

function mockProviders() {
  vi.doMock('@core/channels/register-builtins.js', () => ({}));
  const provider = {
    id: 'telegram',
    label: 'Telegram',
    jidPrefix: 'tg:',
    folderPrefix: 'telegram',
    formatting: 'telegram-html',
    isGroupJid: () => true,
    isEnabled: () => true,
    create: vi.fn(),
    setup: {
      envKeys: ['TELEGRAM_BOT_TOKEN'],
      describe: () => 'Telegram bot',
      run: vi.fn(),
    },
  };
  vi.doMock('@core/channels/provider-registry.js', () => ({
    registerProvider: vi.fn(),
    getProvider: vi.fn((id: string) =>
      id === 'telegram' ? provider : undefined,
    ),
    listConnectableChannelProviders: vi.fn(() => [provider]),
  }));
  return provider;
}

describe('channel CLI command', () => {
  it('lists configured channel readiness', async () => {
    const { note } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(() => ({
        providers: { telegram: { enabled: true } },
      })),
    }));
    vi.doMock('@core/config/env/file.js', () => ({
      readEnvFile: vi.fn(() => ({ TELEGRAM_BOT_TOKEN: 'token' })),
    }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/myclaw', [
      'list',
    ]);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Telegram: enabled | credentials: configured'),
      'Provider Status',
    );
  });

  it('dispatches connect through the provider connector', async () => {
    mockClack();
    mockProviders();
    const runProviderConnectCommand = vi.fn(() => 0);
    vi.doMock('@core/cli/provider-connect.js', () => ({
      runProviderConnectCommand,
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/myclaw', [
      'connect',
      'telegram',
    ]);

    expect(code).toBe(0);
    expect(runProviderConnectCommand).toHaveBeenCalledWith(
      '/tmp/myclaw',
      'telegram',
    );
  });

  it('fails connect when provider is missing', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/myclaw', [
      'connect',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('prints Teams in channel connect usage', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/myclaw', [
      'connect',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('myclaw provider connect <telegram|slack|teams>'),
    );
  });

  it('fails connect for unknown providers', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/myclaw', [
      'connect',
      'unknown',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith('Unknown provider: unknown');
  });

  it('fails unknown channel subcommands', async () => {
    const { error } = mockClack();
    mockProviders();
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/myclaw', [
      'bogus',
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('uses scoped channel health for doctor exit status', async () => {
    const { note } = mockClack();
    mockProviders();
    vi.doMock('@core/cli/doctor.js', () => ({
      runDoctorWithNetwork: vi.fn(async () => ({
        ok: false,
        blockingFailures: 1,
        warnings: 0,
        checks: [
          {
            id: 'postgres-storage',
            title: 'Database',
            status: 'fail',
            message: 'Database down.',
          },
          {
            id: 'telegram-token',
            title: 'Telegram',
            status: 'pass',
            message: 'Telegram ready.',
          },
        ],
      })),
      formatDoctorReport: vi.fn((report) =>
        report.ok ? 'channel ok' : 'channel failed',
      ),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const code = await runProviderCommand(import.meta.url, '/tmp/myclaw', [
      'doctor',
    ]);

    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith('channel ok', 'Provider Doctor');
  });

  it('shows and replaces conversation approvers through local services', async () => {
    const { note } = mockClack();
    mockProviders();
    const iso = new Date(0).toISOString();
    const conversation = {
      id: 'conversation-1',
      appId: 'default',
      providerConnectionId: 'providerConnection-1',
      externalRef: { kind: 'conversation', value: 'app-conv-1' },
      kind: 'channel',
      title: 'Engineering',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    const providerConnection = {
      id: 'providerConnection-1',
      appId: 'default',
      providerId: 'app',
      label: 'App',
      status: 'active',
      config: {},
      runtimeSecretRefs: [],
      createdAt: iso,
      updatedAt: iso,
    };
    const replaceConversationApprovers = vi.fn(async (input: any) =>
      input.externalUserIds.map((externalUserId: string) => ({
        id: `approver:${externalUserId}`,
        appId: 'default',
        conversationId: 'conversation-1',
        externalUserId,
        createdAt: iso,
        updatedAt: iso,
      })),
    );
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      getRuntimeStorage: () => ({
        repositories: {
          providerConnections: {
            getProviderConnection: vi.fn(async () => providerConnection),
            listAgentConversationBindings: vi.fn(async () => []),
            updateProviderConnection: vi.fn(),
          },
          conversations: {
            getConversation: vi.fn(async () => conversation),
            listThreads: vi.fn(async () => []),
            listConversationApprovers: vi.fn(async () => [
              {
                id: 'approver:123',
                appId: 'default',
                conversationId: 'conversation-1',
                externalUserId: '123',
                createdAt: iso,
                updatedAt: iso,
              },
            ]),
            replaceConversationApprovers,
            listParticipantExternalUserIds: vi.fn(async () => ['123', '456']),
          },
        },
      }),
    }));
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      ensureRuntimeSettings: vi.fn(),
    }));
    vi.doMock('@core/config/env/file.js', () => ({ readEnvFile: vi.fn() }));
    vi.doMock('@core/config/settings/runtime-home.js', () => ({
      envFilePath: (runtimeHome: string) => `${runtimeHome}/.env`,
    }));

    const { runProviderCommand } = await import('@core/cli/provider.js');
    const showCode = await runProviderCommand(import.meta.url, '/tmp/myclaw', [
      'control-allowlist',
      'conversation-1',
    ]);
    const setCode = await runProviderCommand(import.meta.url, '/tmp/myclaw', [
      'control-allowlist',
      'conversation-1',
      '--allow',
      '456,456,123',
    ]);

    expect(showCode).toBe(0);
    expect(setCode).toBe(0);
    expect(note).toHaveBeenCalledWith('123', 'Conversation Approvers');
    expect(replaceConversationApprovers).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserIds: ['123', '456'] }),
    );
  });
});
