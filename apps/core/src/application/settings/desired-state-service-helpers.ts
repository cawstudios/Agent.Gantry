import type { AgentId } from '../../domain/agent/agent.js';
import {
  agentIdForFolder,
  folderForAgentId,
} from '../../domain/agent/agent-folder-id.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  ConversationId,
  UserId,
} from '../../domain/conversation/conversation.js';
import type { MemorySubject } from '../../domain/memory/memory.js';
import type { ProviderId } from '../../domain/provider/provider.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import { normalizeRuntimeSecretRefString } from '../../domain/ports/runtime-secret-provider.js';
import { jidForConfiguredConversation } from './desired-state-provider-conversations.js';
import type {
  ConfiguredRoutingBinding,
  StoredAgentBinding,
} from '../../domain/ports/settings-desired-state.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeConfiguredConversation,
  RuntimeSettings,
} from '../../shared/runtime-settings.js';
import type { AgentConfig } from '../../domain/types.js';
import {
  findConversationRouteForQueue,
  makeAgentThreadQueueKey,
  parseAgentThreadQueueKey,
} from '../provider-conversations/thread-queue-key.js';
export { agentIdForFolder, folderForAgentId };
export { classifySettingsChanges } from '../../shared/settings-change-classification.js';

export function configuredRoutingBindingsByAgent(
  settings: RuntimeSettings,
  existingRoutes: Record<string, StoredAgentBinding> = {},
): Map<string, ConfiguredRoutingBinding[]> {
  const result = new Map<string, ConfiguredRoutingBinding[]>();
  for (const binding of configuredRoutingBindings(settings, existingRoutes)) {
    const entries = result.get(binding.agentFolder) ?? [];
    entries.push(binding);
    result.set(binding.agentFolder, entries);
  }
  return result;
}

export function configuredAgentConfig(
  binding: Pick<ConfiguredRoutingBinding, 'model' | 'permissionMode'>,
  agent?: Pick<RuntimeConfiguredAgent, 'persona' | 'relationshipMode'>,
): AgentConfig | undefined {
  const config: AgentConfig = {
    model: binding.model,
    permissionMode: binding.permissionMode,
    persona: agent?.persona,
    relationshipMode: agent?.relationshipMode,
  };
  return Object.values(config).some(Boolean) ? config : undefined;
}

function canonicalRouteConversationId(
  jid: string,
  providerAccountId?: string,
): string | undefined {
  const normalizedProviderAccountId = providerAccountId?.trim();
  if (!normalizedProviderAccountId) return undefined;
  const { chatJid } = parseAgentThreadQueueKey(jid);
  return `conversation:${normalizedProviderAccountId}:${chatJid}`;
}

function configuredRouteConversationId(input: {
  existingRoutes: Record<string, StoredAgentBinding>;
  agentFolder: string;
  jid: string;
  threadId?: string;
  providerAccountId?: string;
}): string | undefined {
  const existingRoute = findConversationRouteForQueue(
    input.existingRoutes,
    makeAgentThreadQueueKey(
      input.jid,
      agentIdForFolder(input.agentFolder),
      input.threadId,
      input.providerAccountId,
    ),
  );
  // Existing legacy IDs stay authoritative; Phase 8 owns their restamp.
  return (
    existingRoute?.conversationId ??
    canonicalRouteConversationId(input.jid, input.providerAccountId)
  );
}

export function configuredRoutingBindings(
  settings: RuntimeSettings,
  existingRoutes: Record<string, StoredAgentBinding> = {},
): ConfiguredRoutingBinding[] {
  const routes: ConfiguredRoutingBinding[] = [];
  const installByRouteIdentity = new Map<string, string>();
  for (const [conversationId, conversation] of Object.entries(
    settings.conversations,
  )) {
    const jid = jidForConfiguredConversation(
      conversation,
      settings.providerAccounts,
    );
    for (const [installKey, install] of Object.entries(
      conversation.installedAgents,
    )) {
      if (install.status !== 'active' || !settings.agents[install.agentId]) {
        continue;
      }
      const providerAccountId =
        install.providerAccountId ?? conversation.providerAccount;
      const routeIdentity = JSON.stringify([
        install.agentId,
        providerAccountId ?? '',
        jid,
        install.threadId ?? '',
      ]);
      const installPath = `${conversationId}.${installKey}`;
      const existingInstallPath = installByRouteIdentity.get(routeIdentity);
      if (existingInstallPath) {
        throw new Error(
          `Duplicate active conversation installs ${existingInstallPath} and ${installPath} resolve to the same runtime route`,
        );
      }
      installByRouteIdentity.set(routeIdentity, installPath);
      routes.push({
        agentFolder: install.agentId,
        conversationId: configuredRouteConversationId({
          existingRoutes,
          agentFolder: install.agentId,
          jid,
          threadId: install.threadId,
          providerAccountId,
        }),
        jid,
        installKey,
        threadId: install.threadId,
        providerAccountId,
        name: conversation.displayName,
        addedAt: install.addedAt,
        requiresTrigger: conversation.requiresTrigger,
        memoryScope: install.memoryScope,
        model: install.model,
        permissionMode: install.permissionMode,
        conversation,
      });
    }
  }
  return routes.sort((left, right) =>
    `${left.agentFolder}:${left.providerAccountId ?? ''}:${left.jid}`.localeCompare(
      `${right.agentFolder}:${right.providerAccountId ?? ''}:${right.jid}`,
    ),
  );
}

export function memorySubjectForConfiguredBinding(input: {
  appId: AppId;
  agentId: AgentId;
  memoryScope: ConfiguredRoutingBinding['memoryScope'];
  conversation: RuntimeConfiguredConversation;
  conversationId: ConversationId;
}): MemorySubject {
  switch (input.memoryScope) {
    case 'app':
      return {
        kind: 'app',
        appId: input.appId,
      };
    case 'agent':
      return {
        kind: 'agent',
        appId: input.appId,
        agentId: input.agentId,
      };
    case 'user':
      if (
        input.conversation.kind === 'dm' ||
        input.conversation.kind === 'direct'
      ) {
        return {
          kind: 'user',
          appId: input.appId,
          userId: input.conversation.externalId as UserId,
        };
      }
      return {
        kind: 'agent',
        appId: input.appId,
        agentId: input.agentId,
      };
    case 'conversation':
      return {
        kind: 'conversation',
        appId: input.appId,
        conversationId: input.conversationId,
      };
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function listDbOnlyGroupJids(input: {
  groups: Record<string, StoredAgentBinding>;
  chats: Array<{ jid: string; is_group?: number }>;
  configuredJids: Set<string>;
}): string[] {
  return [
    ...new Set([
      ...Object.keys(input.groups),
      ...input.chats
        .filter((chat) => chat.is_group === 1)
        .map((chat) => chat.jid),
    ]),
  ]
    .filter((jid) => !input.configuredJids.has(jid))
    .sort();
}

export function normalizeUserIds(userIds: string[]): string[] {
  return [
    ...new Set(
      userIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export function isValidExternalUserId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
}

export function isInternalProviderAccount(providerId: ProviderId): boolean {
  return providerId === 'app' || providerId === 'control-http';
}

export function normalizeRuntimeSecretRefs(input: {
  refs: Record<string, string>;
  pathPrefix: string;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input.refs).map(([key, value]) => [
      key,
      normalizeRuntimeSecretRefString(value, `${input.pathPrefix}.${key}`),
    ]),
  );
}

export function hasAnyCapability(agent: RuntimeConfiguredAgent) {
  return (
    agent.capabilities.length > 0 ||
    agent.sources.skills.length > 0 ||
    agent.sources.mcpServers.length > 0 ||
    agent.sources.tools.length > 0
  );
}

export function groupByAgentId<T extends { agentId: AgentId }>(
  rows: readonly T[],
): Map<AgentId, T[]> {
  const result = new Map<AgentId, T[]>();
  for (const row of rows) {
    const existing = result.get(row.agentId);
    if (existing) {
      existing.push(row);
    } else {
      result.set(row.agentId, [row]);
    }
  }
  return result;
}

export async function loadMcpServersById(
  repository: McpServerRepository,
  serverIds: readonly string[],
): Promise<Map<string, Awaited<ReturnType<McpServerRepository['getServer']>>>> {
  const servers = await Promise.all(
    serverIds.map(
      async (serverId) =>
        [serverId, await repository.getServer(serverId as never)] as const,
    ),
  );
  return new Map(servers);
}
