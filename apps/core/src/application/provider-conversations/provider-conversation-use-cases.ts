import { folderForAgentId } from '../../domain/agent/agent-folder-id.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  Conversation,
  ConversationId,
} from '../../domain/conversation/conversation.js';
import type {
  ConversationInstall,
  ProviderAccount,
  ProviderAccountId,
} from '../../domain/provider/provider.js';
import type {
  ConversationRepository,
  ProviderAccountRepository,
} from '../../domain/ports/repositories.js';
import type { RuntimeSettings } from '../../shared/runtime-settings.js';
import type { Clock } from '../common/clock.js';
import { ApplicationError } from '../common/application-error.js';
import type {
  AgentConversationSummary,
  ConversationAdministrationService,
} from './conversation-administration-service.js';

export interface ProviderStatusInput {
  id: string;
  label: string;
  runtimeSecretKeys: string[];
}

export interface ProviderStatusSummary {
  id: string;
  label: string;
  enabled: boolean;
  credentialStatus: string;
}

interface DesiredStatePort {
  load(appId: AppId): Promise<RuntimeSettings>;
  write(input: {
    appId: AppId;
    settings: RuntimeSettings;
    previousSettings: RuntimeSettings;
    createdBy: string;
  }): Promise<{ restartRequired?: readonly string[] }>;
  resolveConversationId(input: {
    settings: RuntimeSettings;
    value: string;
    providerAccountId?: string;
  }): string;
  applyConversationInstall(input: {
    settings: RuntimeSettings;
    conversation: Pick<Conversation, 'id' | 'externalRef' | 'kind' | 'title'>;
    providerAccountId: string;
    agentFolder: string;
    controlApprovers: readonly string[];
    now: string;
  }): string;
}

export class ProviderConversationUseCases {
  constructor(
    private readonly deps: {
      repositories(): Promise<{
        providerAccounts: ProviderAccountRepository;
        conversations: ConversationRepository;
      }>;
      administration(): Promise<ConversationAdministrationService>;
      desiredState: DesiredStatePort;
      clock: Clock;
    },
  ) {}

  async listProviderStatuses(
    appId: AppId,
    providers: ProviderStatusInput[],
  ): Promise<ProviderStatusSummary[]> {
    const settings = await this.deps.desiredState.load(appId);
    return providers.map((provider) => {
      const accounts = Object.entries(settings.providerAccounts).filter(
        ([, candidate]) =>
          candidate.provider === provider.id && candidate.status !== 'disabled',
      );
      let credentialStatus = 'missing provider account';
      for (const [accountId, account] of accounts) {
        const missing = provider.runtimeSecretKeys.filter(
          (key) => !account.runtimeSecretRefs[key]?.trim(),
        );
        credentialStatus = missing.length
          ? `missing ${accountId}.${missing.join(', ')}`
          : 'secret refs configured';
        if (missing.length === 0) break;
      }
      return {
        id: provider.id,
        label: provider.label,
        enabled: settings.providers?.[provider.id]?.enabled ?? false,
        credentialStatus,
      };
    });
  }

  async listProviderAccounts(appId: AppId): Promise<ProviderAccount[]> {
    const { providerAccounts } = await this.deps.repositories();
    return providerAccounts.listProviderAccounts(appId);
  }

  async connectProviderAccount(input: {
    appId: AppId;
    id: string;
    providerId: string;
    providerLabel: string;
    agentId: string;
    label?: string;
    runtimeSecretRefs: Record<string, string>;
    createdBy: string;
  }): Promise<{ restartRequired?: readonly string[] }> {
    const settings = await this.deps.desiredState.load(input.appId);
    const previousSettings = structuredClone(settings);
    const agentFolder = settingsAgentFolder(settings, input.agentId);
    if (!agentFolder)
      throw new ApplicationError('NOT_FOUND', 'Agent not found');
    settings.providers[input.providerId] = {
      ...(settings.providers[input.providerId] ?? {}),
      enabled: true,
    };
    settings.providerAccounts[input.id] = {
      agentId: agentFolder,
      provider: input.providerId,
      label: input.label || `${input.providerLabel} Provider Account`,
      status: 'active',
      runtimeSecretRefs: input.runtimeSecretRefs,
      config: {},
    };
    return this.deps.desiredState.write({
      appId: input.appId,
      settings,
      previousSettings,
      createdBy: input.createdBy,
    });
  }

  async rotateProviderAccountSecret(input: {
    appId: AppId;
    providerAccountId: string;
    key: string;
    ref: string;
    createdBy: string;
  }): Promise<{ restartRequired?: readonly string[] }> {
    const settings = await this.deps.desiredState.load(input.appId);
    const previousSettings = structuredClone(settings);
    const account = settings.providerAccounts[input.providerAccountId];
    if (!account) {
      throw new ApplicationError('NOT_FOUND', 'Provider Account not found');
    }
    settings.providerAccounts[input.providerAccountId] = {
      ...account,
      runtimeSecretRefs: {
        ...(account.runtimeSecretRefs ?? {}),
        [input.key]: input.ref,
      },
    };
    return this.deps.desiredState.write({
      appId: input.appId,
      settings,
      previousSettings,
      createdBy: input.createdBy,
    });
  }

  async listConversationInstalls(appId: AppId): Promise<ConversationInstall[]> {
    const { providerAccounts } = await this.deps.repositories();
    return providerAccounts.listConversationInstalls(appId);
  }

  async installConversation(input: {
    appId: AppId;
    agentId: string;
    providerAccountId: string;
    conversationId: string;
    createdBy: string;
  }): Promise<{
    agentFolder: string;
    conversation: Conversation;
    restartRequired?: readonly string[];
  }> {
    const settings = await this.deps.desiredState.load(input.appId);
    const previousSettings = structuredClone(settings);
    const agentFolder = settingsAgentFolder(settings, input.agentId);
    if (!agentFolder)
      throw new ApplicationError('NOT_FOUND', 'Agent not found');
    const accountSettings = settings.providerAccounts[input.providerAccountId];
    if (!accountSettings) {
      throw new ApplicationError('NOT_FOUND', 'Provider Account not found');
    }
    if (accountSettings.agentId !== agentFolder) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Provider Account belongs to a different Agent',
      );
    }
    const resolvedConversationId = this.deps.desiredState.resolveConversationId(
      {
        settings,
        value: input.conversationId,
        providerAccountId: input.providerAccountId,
      },
    );
    const repositories = await this.deps.repositories();
    const account = await repositories.providerAccounts.getProviderAccount(
      input.providerAccountId as ProviderAccountId,
    );
    if (!account || account.appId !== input.appId) {
      throw new ApplicationError('NOT_FOUND', 'Provider Account not found');
    }
    if (folderForAgentId(account.agentId as AgentId) !== agentFolder) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Provider Account belongs to a different Agent',
      );
    }
    let conversation: Conversation | null = null;
    let accountMismatch = false;
    for (const candidateId of storedConversationIdCandidates(
      resolvedConversationId,
      input.providerAccountId,
    )) {
      const candidate = await repositories.conversations.getConversation(
        candidateId as ConversationId,
      );
      if (!candidate || candidate.appId !== input.appId) continue;
      if (candidate.providerAccountId !== account.id) {
        accountMismatch = true;
        continue;
      }
      conversation = candidate;
      break;
    }
    if (!conversation && accountMismatch) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Conversation belongs to a different Provider Account',
      );
    }
    if (!conversation) {
      throw new ApplicationError('NOT_FOUND', 'Conversation not found');
    }
    const controlApprovers = (
      await repositories.conversations.listConversationApprovers(
        conversation.id,
      )
    ).map((approver) => approver.externalUserId);
    this.deps.desiredState.applyConversationInstall({
      settings,
      conversation,
      providerAccountId: input.providerAccountId,
      agentFolder,
      controlApprovers,
      now: this.deps.clock.now(),
    });
    const result = await this.deps.desiredState.write({
      appId: input.appId,
      settings,
      previousSettings,
      createdBy: input.createdBy,
    });
    return { agentFolder, conversation, ...result };
  }

  async getConversationSummary(input: {
    appId: AppId;
    conversationId: string;
    providerAccountId?: string;
  }): Promise<AgentConversationSummary> {
    const conversationId = await this.resolveConversationId(input);
    return (await this.deps.administration()).getAgentConversationSummary({
      appId: input.appId,
      conversationId: conversationId as ConversationId,
    });
  }

  async getConversationApprovers(input: {
    appId: AppId;
    conversationId: string;
    providerAccountId?: string;
  }): Promise<{ userIds: string[] }> {
    const conversationId = await this.resolveConversationId(input);
    const summary = await (
      await this.deps.administration()
    ).getAdminSummary({
      appId: input.appId,
      conversationId: conversationId as ConversationId,
    });
    return summary.controlAllowlist;
  }

  async replaceConversationApprovers(input: {
    appId: AppId;
    conversationId: string;
    providerAccountId?: string;
    userIds: string[];
    createdBy: string;
  }): Promise<{
    userIds: string[];
    restartRequired?: readonly string[];
  }> {
    const settings = await this.deps.desiredState.load(input.appId);
    const previousSettings = structuredClone(settings);
    const conversationId = this.deps.desiredState.resolveConversationId({
      settings,
      value: input.conversationId,
      providerAccountId: input.providerAccountId,
    });
    const validated = await (
      await this.deps.administration()
    ).validateControlApprovers({
      appId: input.appId,
      conversationId: conversationId as ConversationId,
      userIds: input.userIds,
    });
    const key = configuredConversationKey(
      settings,
      validated.conversation,
      (value) =>
        this.deps.desiredState.resolveConversationId({ settings, value }),
    );
    if (!key) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Conversation is not configured in desired state',
      );
    }
    const existing = settings.conversations[key];
    if (!existing) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Conversation is not configured in desired state',
      );
    }
    const { conversations } = await this.deps.repositories();
    await conversations.ensureConversationParticipants({
      appId: input.appId,
      conversationId: validated.conversation.id,
      externalUserIds: validated.userIds,
      updatedAt: this.deps.clock.now(),
    });
    settings.conversations[key] = {
      ...existing,
      controlApprovers: validated.userIds,
    };
    const result = await this.deps.desiredState.write({
      appId: input.appId,
      settings,
      previousSettings,
      createdBy: input.createdBy,
    });
    return { userIds: validated.userIds, ...result };
  }

  private async resolveConversationId(input: {
    appId: AppId;
    conversationId: string;
    providerAccountId?: string;
  }): Promise<string> {
    const settings = await this.deps.desiredState.load(input.appId);
    return this.deps.desiredState.resolveConversationId({
      settings,
      value: input.conversationId,
      providerAccountId: input.providerAccountId,
    });
  }
}

function settingsAgentFolder(
  settings: RuntimeSettings,
  agentId: string,
): string | undefined {
  if (settings.agents[agentId]) return agentId;
  const folder = folderForAgentId(agentId as AgentId);
  return folder && settings.agents[folder] ? folder : undefined;
}

function storedConversationIdCandidates(
  resolvedConversationId: string,
  providerAccountId: string,
): string[] {
  const accountPrefix = `conversation:${providerAccountId}:`;
  const jid = resolvedConversationId.startsWith(accountPrefix)
    ? resolvedConversationId.slice(accountPrefix.length)
    : resolvedConversationId.replace(/^conversation:/, '');
  return [
    `conversation:${providerAccountId}:${jid}`,
    `conversation:${jid}`,
  ].filter(
    (candidate, index, candidates) => candidates.indexOf(candidate) === index,
  );
}

function configuredConversationKey(
  settings: RuntimeSettings,
  conversation: Conversation,
  resolve: (value: string) => string,
): string | undefined {
  const exact = Object.keys(settings.conversations).find(
    (key) => resolve(key) === conversation.id,
  );
  if (exact) return exact;
  const externalId = conversation.externalRef?.value;
  if (!externalId) return undefined;
  return Object.entries(settings.conversations).find(
    ([, configured]) =>
      configured.providerAccount === conversation.providerAccountId &&
      configured.externalId === externalId,
  )?.[0];
}
