import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentChannelBinding,
  AgentChannelBindingMemoryScope,
  AgentChannelBindingTriggerMode,
  ChannelInstallation,
  ChannelInstallationId,
  ChannelProviderId,
} from '../../domain/channel/channel.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '../../domain/conversation/conversation.js';
import type { MemorySubject } from '../../domain/memory/memory.js';
import type {
  AgentRepository,
  ChannelInstallationRepository,
  ConversationRepository,
} from '../../domain/ports/repositories.js';
import type { PermissionPolicyId } from '../../domain/permissions/permissions.js';
import type { WorkspaceSnapshotId } from '../../domain/sandbox/sandbox.js';
import type { BrandedId, ExternalRef } from '../../shared/ids/branded-id.js';
import type { Clock } from '../common/clock.js';
import { ApplicationError } from '../common/application-error.js';
import type { IdGenerator } from '../common/id-generator.js';
import type { ChannelProviderCatalogPort } from './channel-provider-ports.js';

export interface ChannelInstallationPatch {
  label?: string;
  status?: ChannelInstallation['status'] | 'inactive' | 'archived';
  enabled?: boolean;
  config?: Record<string, unknown>;
  externalInstallationRef?: ExternalRef<'channel_installation'> | null;
  runtimeSecretRefs?: string[];
}

export interface AgentBindingPatch {
  channelInstallationId?: ChannelInstallationId;
  threadId?: ConversationThreadId;
  displayName?: string;
  triggerMode?: AgentChannelBindingTriggerMode;
  triggerPattern?: string | null;
  requiresTrigger?: boolean;
  isAdminBinding?: boolean;
  memoryScope?: AgentChannelBindingMemoryScope;
  memorySubject?: MemorySubject;
  workspaceSnapshotId?: WorkspaceSnapshotId | null;
  permissionPolicyIds?: PermissionPolicyId[];
  status?: AgentChannelBinding['status'];
}

export interface DiscoveredConversation {
  externalId: string;
  title?: string;
  kind: 'direct' | 'group' | 'channel' | 'service' | 'web';
  status?: 'active' | 'archived' | 'disabled';
  externalRef?: ExternalRef<'conversation'>;
}

export interface ChannelConversationDiscoveryPort {
  discover(input: {
    installation: ChannelInstallation;
    query?: string;
    includeArchived?: boolean;
    limit?: number;
    providerMetadata?: Record<string, unknown>;
  }): Promise<DiscoveredConversation[]>;
}

const SECRET_KEY_PATTERN =
  /(token|secret|password|credential|api[_-]?key|app[_-]?token|bot[_-]?token)/i;

function assertNoRawSecrets(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoRawSecrets(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `${path}.${key} looks like a raw secret. Store channel credentials behind runtimeSecretRefs.`,
      );
    }
    assertNoRawSecrets(nested, `${path}.${key}`);
  }
}

function normalizeInstallationStatus(
  status: ChannelInstallationPatch['status'] | undefined,
): ChannelInstallation['status'] | undefined {
  if (!status) return undefined;
  if (status === 'active' || status === 'disabled') return status;
  if (status === 'inactive' || status === 'archived') return 'disabled';
  return undefined;
}

function assertOwnedInstallation(
  installation: ChannelInstallation,
  appId: AppId,
): void {
  if (installation.appId !== appId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'API key cannot access this channel installation',
    );
  }
}

function triggerModeToRequiresTrigger(
  mode: AgentChannelBindingTriggerMode,
): boolean {
  return mode === 'mention' || mode === 'keyword';
}

function memorySubjectForScope(input: {
  appId: AppId;
  agentId: AgentId;
  conversationId: ConversationId;
  threadId?: ConversationThreadId;
  memoryScope: AgentChannelBindingMemoryScope;
  memorySubject?: MemorySubject;
}): MemorySubject {
  if (input.memorySubject) return input.memorySubject;
  switch (input.memoryScope) {
    case 'app':
      return { kind: 'app', appId: input.appId };
    case 'agent':
      return { kind: 'agent', appId: input.appId, agentId: input.agentId };
    case 'conversation':
      return {
        kind: 'conversation',
        appId: input.appId,
        conversationId: input.conversationId,
      };
    case 'thread':
      if (!input.threadId) {
        return {
          kind: 'conversation',
          appId: input.appId,
          conversationId: input.conversationId,
        };
      }
      return {
        kind: 'thread',
        appId: input.appId,
        conversationId: input.conversationId,
        threadId: input.threadId,
      };
    case 'user':
      throw new ApplicationError(
        'INVALID_REQUEST',
        'memoryScope=user requires an explicit user memorySubject',
      );
  }
}

export class ChannelInstallationControlService {
  constructor(
    private readonly deps: {
      installations: ChannelInstallationRepository;
      providers: ChannelProviderCatalogPort;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async list(appId: AppId): Promise<ChannelInstallation[]> {
    return await this.deps.installations.listChannelInstallations(appId);
  }

  async get(input: {
    appId: AppId;
    installationId: ChannelInstallationId;
  }): Promise<ChannelInstallation> {
    const installation = await this.deps.installations.getChannelInstallation(
      input.installationId,
    );
    if (!installation) {
      throw new ApplicationError('NOT_FOUND', 'Channel installation not found');
    }
    assertOwnedInstallation(installation, input.appId);
    return installation;
  }

  async create(input: {
    appId: AppId;
    providerId: ChannelProviderId;
    label: string;
    config?: Record<string, unknown>;
    externalInstallationRef?: ExternalRef<'channel_installation'>;
    runtimeSecretRefs?: string[];
    enabled?: boolean;
  }): Promise<ChannelInstallation> {
    assertNoRawSecrets(input.config, 'config');
    assertNoRawSecrets(input.externalInstallationRef, 'externalRef');
    const providers = await this.deps.providers.listProviders();
    const provider = providers.find((entry) => entry.id === input.providerId);
    if (!provider || provider.capabilityFlags.includes('placeholder')) {
      throw new ApplicationError(
        'NOT_IMPLEMENTED',
        `Channel provider ${input.providerId} is not implemented`,
      );
    }
    const now = this.deps.clock.now();
    const installation: ChannelInstallation = {
      id: this.deps.ids.generate() as ChannelInstallationId,
      appId: input.appId,
      providerId: input.providerId,
      externalInstallationRef: input.externalInstallationRef,
      label: input.label.trim(),
      status: input.enabled === false ? 'disabled' : 'active',
      config: input.config ?? {},
      runtimeSecretRefs: input.runtimeSecretRefs ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.installations.saveChannelInstallation(installation);
    return installation;
  }

  async update(input: {
    appId: AppId;
    installationId: ChannelInstallationId;
    patch: ChannelInstallationPatch;
  }): Promise<ChannelInstallation> {
    assertNoRawSecrets(input.patch.config, 'config');
    assertNoRawSecrets(input.patch.externalInstallationRef, 'externalRef');
    const existing = await this.get(input);
    const status =
      input.patch.enabled !== undefined
        ? input.patch.enabled
          ? 'active'
          : 'disabled'
        : (normalizeInstallationStatus(input.patch.status) ?? existing.status);
    const updated: ChannelInstallation = {
      ...existing,
      ...(input.patch.label !== undefined
        ? { label: input.patch.label.trim() }
        : {}),
      status,
      ...(input.patch.config !== undefined
        ? { config: input.patch.config }
        : {}),
      ...(input.patch.externalInstallationRef !== undefined
        ? {
            externalInstallationRef:
              input.patch.externalInstallationRef ?? undefined,
          }
        : {}),
      ...(input.patch.runtimeSecretRefs !== undefined
        ? { runtimeSecretRefs: input.patch.runtimeSecretRefs }
        : {}),
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.installations.saveChannelInstallation(updated);
    return updated;
  }

  async disable(input: {
    appId: AppId;
    installationId: ChannelInstallationId;
  }): Promise<ChannelInstallation> {
    const existing = await this.get(input);
    const disabled = await this.deps.installations.disableChannelInstallation({
      appId: input.appId,
      id: existing.id,
      updatedAt: this.deps.clock.now(),
    });
    if (!disabled) {
      throw new ApplicationError('NOT_FOUND', 'Channel installation not found');
    }
    return disabled;
  }
}

export class DiscoverChannelConversationsService {
  constructor(
    private readonly deps: {
      installations: ChannelInstallationRepository;
      conversations: ConversationRepository;
      discovery: ChannelConversationDiscoveryPort;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    appId: AppId;
    installationId: ChannelInstallationId;
    query?: string;
    includeArchived?: boolean;
    limit?: number;
    providerMetadata?: Record<string, unknown>;
  }) {
    const installation = await this.deps.installations.getChannelInstallation(
      input.installationId,
    );
    if (!installation) {
      throw new ApplicationError('NOT_FOUND', 'Channel installation not found');
    }
    assertOwnedInstallation(installation, input.appId);
    if (installation.status !== 'active') {
      throw new ApplicationError(
        'CONFLICT',
        'Channel installation is disabled',
      );
    }
    const discovered = await this.deps.discovery.discover({
      installation,
      query: input.query,
      includeArchived: input.includeArchived,
      limit: input.limit,
      providerMetadata: input.providerMetadata,
    });
    const now = this.deps.clock.now();
    const conversations = [];
    for (const item of discovered) {
      const existing =
        await this.deps.conversations.getConversationByExternalRef({
          appId: input.appId,
          providerId: installation.providerId,
          channelInstallationId: installation.id,
          externalConversationId: item.externalId,
        });
      const conversation = {
        id:
          existing?.id ??
          (`conversation:${installation.id}:${item.externalId}` as ConversationId),
        appId: input.appId,
        channelInstallationId: installation.id,
        externalRef:
          item.externalRef ??
          ({
            kind: 'conversation',
            value: item.externalId,
          } as ExternalRef<'conversation'>),
        kind: item.kind,
        title: item.title,
        status: item.status ?? 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.deps.conversations.saveConversation(conversation);
      conversations.push(conversation);
    }
    return conversations;
  }
}

export class AgentChannelBindingControlService {
  constructor(
    private readonly deps: {
      agents: AgentRepository;
      installations: ChannelInstallationRepository;
      conversations: ConversationRepository;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async list(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentChannelBinding[]> {
    const agent = await this.deps.agents.getAgent(input.agentId);
    if (!agent) throw new ApplicationError('NOT_FOUND', 'Agent not found');
    if (agent.appId !== input.appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this agent',
      );
    }
    const bindings = await this.deps.installations.listAgentChannelBindings(
      input.appId,
    );
    return bindings.filter((binding) => binding.agentId === input.agentId);
  }

  async enable(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    patch: AgentBindingPatch;
  }): Promise<AgentChannelBinding> {
    return await this.upsert({ ...input, requireExisting: false });
  }

  async update(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    patch: AgentBindingPatch;
  }): Promise<AgentChannelBinding> {
    return await this.upsert({ ...input, requireExisting: true });
  }

  async disable(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
  }): Promise<AgentChannelBinding> {
    await this.assertAgent(input.appId, input.agentId);
    const disabled = await this.deps.installations.disableAgentChannelBinding({
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      updatedAt: this.deps.clock.now(),
    });
    if (!disabled) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Agent channel binding not found',
      );
    }
    return disabled;
  }

  private async upsert(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    patch: AgentBindingPatch;
    requireExisting: boolean;
  }): Promise<AgentChannelBinding> {
    await this.assertAgent(input.appId, input.agentId);
    const conversation = await this.deps.conversations.getConversation(
      input.conversationId,
    );
    if (!conversation) {
      throw new ApplicationError('NOT_FOUND', 'Conversation not found');
    }
    if (conversation.appId !== input.appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this conversation',
      );
    }
    const threadId = input.patch.threadId;
    if (threadId) {
      const thread = await this.deps.conversations.getThread(threadId);
      if (!thread || thread.conversationId !== conversation.id) {
        throw new ApplicationError(
          'NOT_FOUND',
          'Conversation thread not found',
        );
      }
    }
    const installationId =
      input.patch.channelInstallationId ?? conversation.channelInstallationId;
    const installation =
      await this.deps.installations.getChannelInstallation(installationId);
    if (!installation) {
      throw new ApplicationError('NOT_FOUND', 'Channel installation not found');
    }
    assertOwnedInstallation(installation, input.appId);
    const existing = await this.deps.installations.getAgentChannelBinding({
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId,
    });
    if (input.requireExisting && !existing) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Agent channel binding not found',
      );
    }
    const triggerMode =
      input.patch.triggerMode ?? existing?.triggerMode ?? 'always';
    const memoryScope =
      input.patch.memoryScope ?? existing?.memoryScope ?? 'conversation';
    const now = this.deps.clock.now();
    const binding: AgentChannelBinding = {
      id:
        existing?.id ??
        (this.deps.ids.generate() as BrandedId<'AgentChannelBindingId'>),
      appId: input.appId,
      agentId: input.agentId,
      channelInstallationId: installation.id,
      conversationId: conversation.id,
      ...(threadId
        ? { threadId }
        : existing?.threadId
          ? { threadId: existing.threadId }
          : {}),
      displayName:
        input.patch.displayName ??
        existing?.displayName ??
        conversation.title ??
        conversation.id,
      status: input.patch.status ?? 'active',
      triggerMode,
      triggerPattern:
        input.patch.triggerPattern === null
          ? undefined
          : (input.patch.triggerPattern ?? existing?.triggerPattern),
      requiresTrigger:
        input.patch.requiresTrigger ??
        triggerModeToRequiresTrigger(triggerMode),
      isAdminBinding:
        input.patch.isAdminBinding ?? existing?.isAdminBinding ?? false,
      memoryScope,
      memorySubject: memorySubjectForScope({
        appId: input.appId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        threadId: threadId ?? existing?.threadId,
        memoryScope,
        memorySubject: input.patch.memorySubject,
      }),
      workspaceSnapshotId:
        input.patch.workspaceSnapshotId === null
          ? undefined
          : (input.patch.workspaceSnapshotId ?? existing?.workspaceSnapshotId),
      permissionPolicyIds:
        input.patch.permissionPolicyIds ?? existing?.permissionPolicyIds ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.installations.saveAgentChannelBinding(binding);
    return binding;
  }

  private async assertAgent(appId: AppId, agentId: AgentId): Promise<void> {
    const agent = await this.deps.agents.getAgent(agentId);
    if (!agent) throw new ApplicationError('NOT_FOUND', 'Agent not found');
    if (agent.appId !== appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this agent',
      );
    }
  }
}
