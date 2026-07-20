import * as p from '@clack/prompts';

import {
  ConversationAdministrationService,
  type AgentConversationSummary,
} from '../application/provider-conversations/conversation-administration-service.js';
import {
  ProviderConversationUseCases,
  type ProviderStatusSummary,
} from '../application/provider-conversations/provider-conversation-use-cases.js';
import { ApplicationError } from '../application/common/application-error.js';
import { createRepositoryRuntimeSecretProvider } from '../adapters/credentials/repository-runtime-secret-provider.js';
import { RuntimeSecretConversationMembershipValidator } from '../channels/conversation-membership-validation.js';
import {
  getProvider,
  listConnectableChannelProviders,
} from '../channels/provider-registry.js';
import { applyConversationInstallToSettings } from '../config/settings/conversation-install-settings.js';
import {
  loadDesiredRuntimeSettingsForWrite,
  noteRestartRequired,
  writeDesiredRuntimeSettings,
} from '../config/settings/desired-settings-writer.js';
import { runtimeSecretKeyForEnv } from '../domain/provider/provider-runtime-secret-keys.js';
import type { RuntimeSettings } from '../shared/runtime-settings.js';
import type { DoctorReport } from './doctor.js';
import {
  assertRuntimeSecretRef,
  conversationIdFromConfigured,
  option,
  parseRuntimeSecretRefOptions,
  soleProviderAccountIdForJid,
} from './provider-utils.js';
import { nowIso } from '../shared/time/datetime.js';

const DEFAULT_APP_ID = 'default' as never;

function usage(): string {
  return [
    'Usage:',
    '  gantry provider account connect <provider> --agent <agent-id> [--secret-ref key=ref]',
    '  gantry provider account list',
    '  gantry provider account rotate-secret <provider-account-id> --key <key> --ref <runtime-secret-ref>',
    '  gantry provider doctor',
    '  gantry provider list',
    '  gantry provider connect <telegram|slack|discord|teams>',
    '  gantry conversation install --agent <agent-id> --provider-account <id> --conversation <conversationId>',
    '  gantry conversation installs list',
    '  gantry conversation info <conversationId>',
    '  gantry conversation approvers <conversationId> [--allow <userId,userId>]',
  ].join('\n');
}

async function formatProviderList(runtimeHome: string): Promise<string> {
  const providers = listConnectableChannelProviders();
  const statuses = await providerConversationUseCases(
    runtimeHome,
  ).listProviderStatuses(
    DEFAULT_APP_ID,
    providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      runtimeSecretKeys: provider.setup.envKeys.map((envKey) =>
        runtimeSecretKeyForEnv(provider.id, envKey),
      ),
    })),
  );
  const lines = ['Providers', ''];
  for (const status of statuses) {
    lines.push(formatProviderStatus(status));
  }
  return lines.join('\n');
}

function formatProviderStatus(status: ProviderStatusSummary): string {
  return `${status.label}: ${status.enabled ? 'enabled' : 'disabled'} | credentials: ${status.credentialStatus}`;
}

function scopeProviderDoctorReport(report: DoctorReport): DoctorReport {
  const channelChecks = report.checks.filter((check) =>
    [
      'runtime-settings',
      'telegram-token',
      'telegram-token-api',
      'slack-tokens',
      'slack-token-api',
      'discord-credentials',
      'teams-credentials',
    ].includes(check.id),
  );
  const checks = channelChecks.length > 0 ? channelChecks : report.checks;
  const blockingFailures = checks.filter(
    (check) => check.status === 'fail',
  ).length;
  return {
    ...report,
    checks,
    blockingFailures,
    warnings: checks.filter((check) => check.status === 'warn').length,
    ok: blockingFailures === 0,
  };
}

export async function runProviderCommand(
  importMetaUrl: string,
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, providerId] = args;
  if (command === 'account') {
    return runProviderAccountCommand(runtimeHome, args.slice(1));
  }
  if (!command || command === 'list') {
    p.note(await formatProviderList(runtimeHome), 'Provider Status');
    return 0;
  }

  if (command === 'connect') {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    const provider = getProvider(providerId);
    if (!provider) {
      p.log.error(`Unknown provider: ${providerId}`);
      return 1;
    }
    const { runProviderConnectCommand } = await import('./provider-connect.js');
    return runProviderConnectCommand(runtimeHome, provider.id);
  }

  if (command === 'doctor') {
    const { formatDoctorReport, runDoctorWithNetwork } =
      await import('./doctor.js');
    // Provider doctor reports only channel checks — skip the live model
    // credential probes whose results the scoped report would discard.
    const report = await runDoctorWithNetwork(importMetaUrl, runtimeHome, {
      validateModelCredentials: false,
    });
    const scoped = scopeProviderDoctorReport(report);
    p.note(formatDoctorReport(scoped), 'Provider Doctor');
    return scoped.ok ? 0 : 1;
  }

  p.log.error(usage());
  return 1;
}

export async function runConversationCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, conversationId] = args;
  if (command === 'install') {
    return runConversationInstallCommand(runtimeHome, args.slice(1));
  }
  if (command === 'installs' && conversationId === 'list') {
    try {
      const installs = await withRuntimeStorage(() =>
        providerConversationUseCases(runtimeHome).listConversationInstalls(
          DEFAULT_APP_ID,
        ),
      );
      p.note(formatConversationInstalls(installs), 'Conversation Installs');
      return 0;
    } catch (error) {
      p.log.error(formatConversationAdminError(error));
      return 1;
    }
  }
  if (command === 'info' && conversationId) {
    try {
      const summary = await withRuntimeStorage(() =>
        providerConversationUseCases(runtimeHome).getConversationSummary({
          appId: DEFAULT_APP_ID,
          conversationId,
          providerAccountId: option(args, '--provider-account') || undefined,
        }),
      );
      p.note(formatConversationInfo(summary), 'Conversation Info');
      return 0;
    } catch (error) {
      p.log.error(formatConversationAdminError(error));
      return 1;
    }
  }
  if (command === 'approvers' && conversationId) {
    const allowIndex = args.indexOf('--allow');
    const allowValue = allowIndex >= 0 ? args[allowIndex + 1] || '' : '';
    try {
      const useCases = providerConversationUseCases(runtimeHome);
      const selector = {
        appId: DEFAULT_APP_ID,
        conversationId,
        providerAccountId: option(args, '--provider-account') || undefined,
      };
      let userIds: string[];
      if (allowIndex >= 0) {
        const result = await withRuntimeStorage(() =>
          useCases.replaceConversationApprovers({
            ...selector,
            userIds: parseCsv(allowValue),
            createdBy: 'cli:conversation-approvers',
          }),
        );
        noteRestartRequired(result);
        userIds = result.userIds;
      } else {
        userIds = (
          await withRuntimeStorage(() =>
            useCases.getConversationApprovers(selector),
          )
        ).userIds;
      }
      p.note(formatUserList(userIds), 'Conversation Approvers');
      return 0;
    } catch (error) {
      p.log.error(formatConversationAdminError(error));
      return 1;
    }
  }
  p.log.error(usage());
  return 1;
}

async function runProviderAccountCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, idOrProvider] = args;
  try {
    if (!command || command === 'list') {
      const accounts = await withRuntimeStorage(() =>
        providerConversationUseCases(runtimeHome).listProviderAccounts(
          DEFAULT_APP_ID,
        ),
      );
      p.note(formatProviderAccounts(accounts), 'Provider Accounts');
      return 0;
    }
    if (command === 'connect') {
      return await connectProviderAccount(idOrProvider, args.slice(2));
    }
    if (command === 'rotate-secret') {
      return await rotateProviderAccountSecret(idOrProvider, args.slice(2));
    }
  } catch (error) {
    p.log.error(formatConversationAdminError(error));
    return 1;
  }
  p.log.error(usage());
  return 1;

  async function connectProviderAccount(
    providerId: string | undefined,
    rest: string[],
  ): Promise<number> {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    const provider = getProvider(providerId);
    if (!provider) {
      p.log.error(`Unknown provider: ${providerId}`);
      return 1;
    }
    const agentId = option(rest, '--agent');
    if (!agentId) {
      p.log.error('Provider Account connect requires --agent <agent-id>.');
      return 1;
    }
    const runtimeSecretRefs = parseRuntimeSecretRefOptions(rest);
    const label =
      option(rest, '--label') || `${provider.label} Provider Account`;
    const id =
      option(rest, '--id') ||
      `provider-account:${provider.id}:${agentId}:${Date.now()}`;
    const result = await providerConversationUseCases(
      runtimeHome,
    ).connectProviderAccount({
      appId: DEFAULT_APP_ID,
      id,
      providerId: provider.id,
      providerLabel: provider.label,
      agentId,
      label,
      runtimeSecretRefs,
      createdBy: 'cli:provider-account-connect',
    });
    noteRestartRequired(result);
    p.note(
      [
        `Provider Account: ${label}`,
        `Agent: ${agentId}`,
        `Status: ${Object.keys(runtimeSecretRefs).length ? 'Installed' : 'Needs setup'}`,
      ].join('\n'),
      'Provider Account',
    );
    return 0;
  }

  async function rotateProviderAccountSecret(
    providerAccountId: string | undefined,
    rest: string[],
  ): Promise<number> {
    if (!providerAccountId) {
      p.log.error(usage());
      return 1;
    }
    const key = option(rest, '--key');
    const ref = option(rest, '--ref');
    if (!key || !ref) {
      p.log.error(
        'Provider Account rotate-secret requires --key <key> --ref <runtime-secret-ref>.',
      );
      return 1;
    }
    assertRuntimeSecretRef(ref);
    const result = await providerConversationUseCases(
      runtimeHome,
    ).rotateProviderAccountSecret({
      appId: DEFAULT_APP_ID,
      providerAccountId,
      key,
      ref,
      createdBy: 'cli:provider-account-rotate-secret',
    });
    noteRestartRequired(result);
    p.note('Provider Account secret ref updated.', 'Provider Account');
    return 0;
  }
}

async function runConversationInstallCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const agentId = option(args, '--agent');
  const providerAccountId = option(args, '--provider-account');
  const conversationId = option(args, '--conversation');
  if (!agentId || !providerAccountId || !conversationId) {
    p.log.error(usage());
    return 1;
  }
  try {
    const result = await withRuntimeStorage(() =>
      providerConversationUseCases(runtimeHome).installConversation({
        appId: DEFAULT_APP_ID,
        agentId,
        providerAccountId,
        conversationId,
        createdBy: 'cli:conversation-install',
      }),
    );
    noteRestartRequired(result);
    p.note(
      [
        `Agent: ${result.agentFolder}`,
        `Conversation: ${result.conversation.id}`,
        `Provider Account: ${providerAccountId}`,
        'Status: Installed',
      ].join('\n'),
      'Conversation Install',
    );
    return 0;
  } catch (error) {
    p.log.error(formatConversationAdminError(error));
    return 1;
  }
}

function formatProviderAccounts(
  rows: Awaited<
    ReturnType<ProviderConversationUseCases['listProviderAccounts']>
  >,
): string {
  if (rows.length === 0) return 'Provider Accounts: none';
  return rows
    .map((account) =>
      [
        `Provider Account: ${account.label}`,
        `Agent: ${account.agentId}`,
        `Status: ${account.status === 'active' ? 'Installed' : 'Needs setup'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function formatConversationInstalls(
  rows: Awaited<
    ReturnType<ProviderConversationUseCases['listConversationInstalls']>
  >,
): string {
  if (rows.length === 0) return 'Conversation Installs: none';
  return rows
    .map((install) =>
      [
        `Agent: ${install.agentId}`,
        `Conversation: ${install.conversationId}`,
        `Provider Account: ${install.providerAccountId}`,
        `Status: ${install.status === 'active' ? 'Installed' : 'Needs setup'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function formatConversationInfo(summary: AgentConversationSummary): string {
  const { conversation } = summary;
  return [
    `Conversation: ${conversation.title || conversation.id}`,
    `ID: ${conversation.id}`,
    `Status: ${conversation.status}`,
    `Agents: ${summary.agentIds.join(', ') || 'none'}`,
    `Sessions: ${summary.threadCount}`,
    `Conversation approvers: ${formatUserList(summary.controlAllowlist.userIds)}`,
  ].join('\n');
}

async function conversationAdministrationService(): Promise<ConversationAdministrationService> {
  const repositories = await runtimeRepositories();
  return new ConversationAdministrationService(
    {
      providerAccounts: repositories.providerAccounts,
      conversations: repositories.conversations,
    },
    new RuntimeSecretConversationMembershipValidator(
      createRepositoryRuntimeSecretProvider({
        appId: DEFAULT_APP_ID,
        repository: repositories.capabilitySecrets,
      }),
    ),
  );
}

function providerConversationUseCases(
  runtimeHome: string,
): ProviderConversationUseCases {
  return new ProviderConversationUseCases({
    repositories: async () => {
      const repositories = await runtimeRepositories();
      return {
        providerAccounts: repositories.providerAccounts,
        conversations: repositories.conversations,
      };
    },
    administration: conversationAdministrationService,
    desiredState: {
      load: (appId) =>
        loadDesiredRuntimeSettingsForWrite({ runtimeHome, appId }),
      write: ({ appId, settings, previousSettings, createdBy }) =>
        writeDesiredRuntimeSettings({
          runtimeHome,
          appId,
          settings,
          previousSettings,
          createdBy,
        }),
      resolveConversationId: ({ settings, value, providerAccountId }) =>
        resolveConversationIdArgument(settings, value, providerAccountId),
      applyConversationInstall: applyConversationInstallToSettings,
    },
    clock: { now: nowIso },
  });
}

async function runtimeRepositories() {
  const { getRuntimeStorage } =
    await import('../adapters/storage/postgres/runtime-store.js');
  return getRuntimeStorage().repositories;
}

function resolveConversationIdArgument(
  settings: RuntimeSettings,
  conversationIdOrJid: string,
  providerAccountId?: string,
): string {
  const value = conversationIdOrJid.trim();
  if (value.startsWith('conversation:')) return value;
  const configured = settings?.conversations?.[value];
  if (configured) return conversationIdFromConfigured(settings, configured);
  const matchingConfigured = Object.values(settings.conversations ?? {})
    .map((entry) => conversationIdFromConfigured(settings, entry))
    .filter((conversationId) => conversationId.endsWith(`:${value}`));
  if (matchingConfigured.length === 1) return matchingConfigured[0];
  if (/^[a-z][a-z0-9_-]*:/i.test(value)) {
    const accountId =
      providerAccountId || soleProviderAccountIdForJid(settings, value);
    if (!accountId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Raw conversation IDs require --provider-account <id> or a configured conversation key.',
      );
    }
    return `conversation:${accountId}:${value}`;
  }
  return value;
}

async function withRuntimeStorage<T>(fn: () => Promise<T>): Promise<T> {
  const { closeRuntimeStorage, initializeRuntimeStorage } =
    await import('../adapters/storage/postgres/runtime-store.js');
  await initializeRuntimeStorage();
  try {
    return await fn();
  } finally {
    await closeRuntimeStorage();
  }
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatUserList(userIds: string[]): string {
  return userIds.length > 0 ? userIds.join(', ') : 'none';
}

function formatConversationAdminError(error: unknown): string {
  if (error instanceof ApplicationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
