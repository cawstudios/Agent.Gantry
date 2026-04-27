import type { AppId } from '../../../domain/app/app.js';
import type {
  AgentChannelBinding,
  ChannelInstallation,
  ChannelInstallationId,
  ChannelProvider,
} from '../../../domain/channel/channel.js';
import type {
  Conversation,
  ConversationId,
  ConversationThread,
  ConversationThreadId,
  UserId,
} from '../../../domain/conversation/conversation.js';
import type { MemorySubject } from '../../../domain/memory/memory.js';
import type {
  Message,
  MessagePart,
} from '../../../domain/messages/messages.js';
import type { PermissionPolicyId } from '../../../domain/permissions/permissions.js';
import type { WorkspaceSnapshotId } from '../../../domain/sandbox/sandbox.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { ExternalRef } from '../../../shared/ids/branded-id.js';
import { ApplicationError } from '../../../application/common/application-error.js';
import type { AgentBindingPatch } from '../../../application/channels/channel-control-use-cases.js';

export function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) return undefined;
  return value;
}

export function externalRefFromContract<Kind extends string>(
  ref: { kind?: string; id: string } | undefined,
  fallbackKind: Kind,
): ExternalRef<Kind> | undefined {
  if (!ref) return undefined;
  return {
    kind: fallbackKind,
    value: ref.id,
  } as ExternalRef<Kind>;
}

function externalRefToContract(ref: ExternalRef<string> | undefined) {
  return ref ? { kind: ref.kind, id: ref.value } : undefined;
}

function memorySubjectToContract(subject: MemorySubject | undefined) {
  if (!subject) return undefined;
  switch (subject.kind) {
    case 'app':
      return { type: 'app', id: subject.appId };
    case 'agent':
      return { type: 'agent', id: subject.agentId };
    case 'user':
      return { type: 'user', id: subject.userId };
    case 'conversation':
      return { type: 'conversation', id: subject.conversationId };
    case 'thread':
      return { type: 'thread', id: subject.threadId };
  }
}

export function memorySubjectFromContract(
  appId: AppId,
  raw: { type: string; id: string } | undefined,
  conversationId?: ConversationId,
): MemorySubject | undefined {
  if (!raw) return undefined;
  switch (raw.type) {
    case 'app':
      return { kind: 'app', appId };
    case 'agent':
      return { kind: 'agent', appId, agentId: raw.id as AgentId };
    case 'user':
      return { kind: 'user', appId, userId: raw.id as UserId };
    case 'conversation':
      return {
        kind: 'conversation',
        appId,
        conversationId: raw.id as ConversationId,
      };
    case 'thread':
      if (!conversationId) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          'thread memorySubject requires a conversation context',
        );
      }
      return {
        kind: 'thread',
        appId,
        conversationId,
        threadId: raw.id as ConversationThreadId,
      };
    default:
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Unsupported memorySubject type for channel binding',
      );
  }
}

export function providerToResponse(provider: ChannelProvider) {
  const placeholder = provider.capabilityFlags.includes('placeholder');
  return {
    id: provider.id,
    displayName: provider.displayName,
    capabilities: provider.capabilityFlags,
    status: placeholder ? 'unavailable' : 'available',
    placeholder: placeholder || undefined,
    createdAt: provider.createdAt,
  };
}

export function installationToResponse(installation: ChannelInstallation) {
  return {
    id: installation.id,
    appId: installation.appId,
    providerId: installation.providerId,
    label: installation.label,
    status: installation.status,
    config: installation.config,
    externalRef: externalRefToContract(installation.externalInstallationRef),
    runtimeSecretRefs: installation.runtimeSecretRefs,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

function conversationKindToContract(kind: Conversation['kind']) {
  if (kind === 'direct') return 'dm';
  if (kind === 'service') return 'sdk';
  return kind;
}

function conversationStatusToContract(status: Conversation['status']) {
  return status === 'disabled' ? 'inactive' : status;
}

export function conversationToResponse(conversation: Conversation) {
  return {
    id: conversation.id,
    appId: conversation.appId,
    channelInstallationId: conversation.channelInstallationId,
    externalRef: externalRefToContract(conversation.externalRef),
    kind: conversationKindToContract(conversation.kind),
    title: conversation.title ?? null,
    status: conversationStatusToContract(conversation.status),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export function threadToResponse(thread: ConversationThread) {
  return {
    id: thread.id,
    appId: thread.appId,
    conversationId: thread.conversationId,
    externalRef: externalRefToContract(thread.externalRef),
    title: thread.title ?? null,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function messagePartToResponse(part: MessagePart, ordinal: number) {
  switch (part.kind) {
    case 'text':
      return { ordinal, kind: 'text', payload: { text: part.text } };
    case 'markdown':
      return {
        ordinal,
        kind: 'markdown',
        payload: { markdown: part.markdown },
      };
    case 'code':
      return {
        ordinal,
        kind: 'code',
        payload: { code: part.code, language: part.language },
      };
    case 'structured':
      return { ordinal, kind: 'structured', payload: part.value };
    case 'tool_result':
      return {
        ordinal,
        kind: 'tool_result',
        payload: { toolId: part.toolId, value: part.value },
      };
    case 'redacted':
      return { ordinal, kind: 'redacted', payload: { reason: part.reason } };
  }
}

export function messageToResponse(message: Message) {
  return {
    id: message.id,
    appId: message.appId,
    conversationId: message.conversationId,
    threadId: message.threadId ?? null,
    externalMessageId: message.externalRef?.value ?? null,
    externalRef: externalRefToContract(message.externalRef),
    direction: message.direction,
    senderUserId: message.senderUserId ?? null,
    senderDisplayName: message.senderDisplayName ?? null,
    trust: message.trust,
    deliveryStatus: message.deliveryStatus ?? null,
    deliveredAt: message.deliveredAt ?? null,
    deliveryError: message.deliveryError ?? null,
    parts: message.parts.map(messagePartToResponse),
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      contentType: attachment.contentType ?? null,
      sizeBytes: attachment.sizeBytes ?? null,
      externalRef: externalRefToContract(attachment.externalRef),
      storageRef: attachment.storageRef ?? null,
      trust: attachment.trust,
    })),
    createdAt: message.createdAt,
    receivedAt: message.receivedAt ?? null,
  };
}

export function bindingToResponse(binding: AgentChannelBinding) {
  return {
    id: binding.id,
    appId: binding.appId,
    agentId: binding.agentId,
    channelInstallationId: binding.channelInstallationId,
    conversationId: binding.conversationId,
    threadId: binding.threadId ?? null,
    displayName: binding.displayName,
    status: binding.status,
    triggerMode: binding.triggerMode,
    triggerPattern: binding.triggerPattern ?? null,
    requiresTrigger: binding.requiresTrigger,
    isAdminBinding: binding.isAdminBinding,
    memoryScope: binding.memoryScope,
    memorySubject: memorySubjectToContract(binding.memorySubject),
    workspaceSnapshotId: binding.workspaceSnapshotId ?? null,
    permissionPolicyIds: binding.permissionPolicyIds,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

export function bindingPatchFromParsed(
  appId: AppId,
  conversationId: ConversationId,
  data: {
    channelInstallationId?: string;
    threadId?: string;
    displayName?: string;
    triggerMode?: AgentBindingPatch['triggerMode'];
    triggerPattern?: string | null;
    requiresTrigger?: boolean;
    isAdminBinding?: boolean;
    memoryScope?: AgentBindingPatch['memoryScope'];
    memorySubject?: { type: string; id: string };
    workspaceSnapshotId?: string | null;
    permissionPolicyIds?: string[];
    status?: AgentBindingPatch['status'];
  },
): AgentBindingPatch {
  return {
    ...(data.channelInstallationId
      ? {
          channelInstallationId:
            data.channelInstallationId as ChannelInstallationId,
        }
      : {}),
    ...(data.threadId
      ? { threadId: data.threadId as ConversationThreadId }
      : {}),
    ...(data.displayName ? { displayName: data.displayName } : {}),
    ...(data.triggerMode ? { triggerMode: data.triggerMode } : {}),
    ...(data.triggerPattern !== undefined
      ? { triggerPattern: data.triggerPattern }
      : {}),
    ...(data.requiresTrigger !== undefined
      ? { requiresTrigger: data.requiresTrigger }
      : {}),
    ...(data.isAdminBinding !== undefined
      ? { isAdminBinding: data.isAdminBinding }
      : {}),
    ...(data.memoryScope ? { memoryScope: data.memoryScope } : {}),
    ...(data.memorySubject
      ? {
          memorySubject: memorySubjectFromContract(
            appId,
            data.memorySubject,
            conversationId,
          ),
        }
      : {}),
    ...(data.workspaceSnapshotId !== undefined
      ? {
          workspaceSnapshotId:
            data.workspaceSnapshotId === null
              ? null
              : (data.workspaceSnapshotId as WorkspaceSnapshotId),
        }
      : {}),
    ...(data.permissionPolicyIds !== undefined
      ? {
          permissionPolicyIds: data.permissionPolicyIds as PermissionPolicyId[],
        }
      : {}),
    ...(data.status ? { status: data.status } : {}),
  };
}
