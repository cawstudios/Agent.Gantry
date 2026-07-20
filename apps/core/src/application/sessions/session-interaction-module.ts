import type {
  AgentControlOverrides,
  AppMessageResponseRoute,
  CallerResolvedToolsConfig,
  NewMessage,
  SessionContinuityMode,
} from '../../domain/types.js';
import type {
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventPublishInput,
  RuntimeResponseMode,
} from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { RuntimeEventExchange } from '../runtime-events/runtime-event-exchange.js';
import type {
  RuntimeChatMetadataRepository,
  RuntimeMessageRepository,
} from '../../domain/repositories/ops-repo.js';
import type { LiveAdmissionWorkItemEnqueueResult } from '../../domain/ports/live-turns.js';
import type { SdkSessionQueuePolicy } from '../../domain/ports/live-turns.js';
import type {
  AgentRepository,
  AgentRunRepository,
  AgentSessionRepository,
  MessageRepository,
  ProviderSessionRepository,
} from '../../domain/ports/repositories.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import type { AgentRuntime } from '../../shared/agent-runtime.js';
import { ApplicationError } from '../common/application-error.js';
import { isValidControlId } from '../../shared/control-id.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import { MAX_WORKSPACE_FOLDER_LENGTH } from '../../shared/workspace-folder-policy.js';
import { folderForAgentId } from '../../domain/agent/agent-folder-id.js';
import { canonicalJson } from '../../shared/canonical-json.js';

type ControlResponseMode = Exclude<RuntimeResponseMode, 'sse'> | 'sse';

export type SessionAppRecord = {
  sessionId: string;
  appId: string;
  agentId?: string | null;
  conversationId: string;
  conversationJid: string;
  workspaceKey: string;
  title?: string | null;
  defaultResponseMode: ControlResponseMode;
  defaultWebhookId: string | null;
};

export type SessionResponseRouteRecord = {
  responseMode: ControlResponseMode;
  webhookId: string | null;
  correlationId: string | null;
};

export interface SessionControlPort {
  ensureAppSession(input: {
    appId: string;
    conversationId: string;
    conversationJid: string;
    folder: string;
    agentId?: string;
    title?: string | null;
    defaultResponseMode?: ControlResponseMode;
    defaultWebhookId?: string | null;
  }): Promise<SessionAppRecord>;
  getAppSessionById(sessionId: string): Promise<SessionAppRecord | undefined>;
  getAppSessionByChatJid(
    conversationJid: string,
  ): Promise<SessionAppRecord | undefined>;
  getWebhookById(
    webhookId: string,
    appId: string,
  ): Promise<{ webhookId: string } | undefined>;
  upsertAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
    responseMode: ControlResponseMode;
    webhookId?: string | null;
    correlationId?: string | null;
  }): Promise<SessionResponseRouteRecord>;
  getAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
  }): Promise<SessionResponseRouteRecord | undefined>;
}

export type SessionInteractionDeps = {
  control: SessionControlPort;
  ops: RuntimeChatMetadataRepository & RuntimeMessageRepository;
  repositories: {
    agents: AgentRepository;
    agentSessions: AgentSessionRepository;
    providerSessions: ProviderSessionRepository;
    messages: MessageRepository;
    agentRuns: AgentRunRepository;
  };
  runtimeEvents: RuntimeEventExchange;
  liveAdmissionAppId?: string | null;
  getConfiguredAgentRuntime?: (agentFolder: string) => AgentRuntime | undefined;
  now: () => IsoTimestamp;
  createId: () => string;
  stableHash: (input: string) => string;
};

export type SessionQueueIntent = {
  conversationJid: string;
  threadId: string | null;
  queueKey: string;
  durableAdmissionCreated: boolean;
};

export class SessionInteractionModule {
  constructor(private readonly deps: SessionInteractionDeps) {}

  async ensureSession(input: {
    appId: string;
    assertedAppId?: string | null;
    agentId?: string | null;
    agentName?: string | null;
    conversationId: string;
    title?: string | null;
    responseMode?: unknown;
    webhookId?: string | null;
  }): Promise<{
    session: SessionAppRecord;
    registerGroup: { conversationJid: string; group: AppGroupRegistration };
  }> {
    assertAppScope(input.appId, input.assertedAppId);
    const conversationId = input.conversationId.trim();
    if (!conversationId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'conversationId is required',
      );
    }
    if (!isValidControlId(input.appId) || !isValidControlId(conversationId)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'appId and conversationId must contain only letters, numbers, dot, underscore, or dash',
      );
    }
    const conversationJid = `app:${input.appId}:${conversationId}`;
    const selectedAgent = await this.resolveSessionAgent({
      appId: input.appId,
      agentId: input.agentId ?? null,
      agentName: input.agentName ?? null,
    });
    const group = makeAppGroup({
      appId: input.appId,
      conversationId,
      conversationJid,
      identityHash: this.deps
        .stableHash(`${input.appId}\0${conversationId}`)
        .slice(0, 12),
      addedAt: this.deps.now(),
    });
    if (selectedAgent) group.folder = selectedAgent.folder;
    const defaultWebhookId = await this.resolveOwnedWebhookId(
      input.appId,
      input.webhookId ?? null,
    );
    const session = await this.deps.control.ensureAppSession({
      appId: input.appId,
      conversationId,
      conversationJid,
      folder: group.folder,
      agentId: selectedAgent?.id,
      title: input.title ?? null,
      defaultResponseMode: normalizeResponseMode(input.responseMode, 'sse'),
      defaultWebhookId,
    });
    return { session, registerGroup: { conversationJid, group } };
  }

  private async resolveSessionAgent(input: {
    appId: string;
    agentId: string | null;
    agentName: string | null;
  }): Promise<{ id: string; folder: string } | null> {
    const agentId = input.agentId?.trim() ?? '';
    const agentName = input.agentName?.trim() ?? '';
    if (agentId && agentName) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Specify either agentId or agentName, not both',
      );
    }
    if (!agentId && !agentName) return null;
    const matches = agentId
      ? [await this.deps.repositories.agents.getAgent(agentId as never)].filter(
          Boolean,
        )
      : (
          await this.deps.repositories.agents.listAgents(input.appId as never)
        ).filter((agent) => agent.name === agentName);
    if (matches.length !== 1) {
      throw new ApplicationError(
        'NOT_FOUND',
        agentId ? 'Agent not found' : 'Exactly one matching agent is required',
      );
    }
    const agent = matches[0]!;
    if (String(agent.appId) !== input.appId || agent.status !== 'active') {
      throw new ApplicationError('NOT_FOUND', 'Active agent not found');
    }
    const folder = folderForAgentId(agent.id);
    if (!folder)
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Agent has no workspace folder',
      );
    return { id: String(agent.id), folder };
  }

  async getSessionDetails(input: {
    appId: string;
    sessionId: string;
  }): Promise<{ session: unknown; providerSession: unknown | null }> {
    const appSession = await this.requireSession(input);
    const session = await this.deps.repositories.agentSessions.getAgentSession(
      appSession.sessionId as never,
    );
    if (!session) {
      throw new ApplicationError('NOT_FOUND', 'Session not found');
    }
    const providerSession =
      await this.deps.repositories.providerSessions.getLatestProviderSession({
        agentSessionId: session.id,
      });
    return {
      session,
      providerSession: providerSession
        ? {
            provider: providerSession.provider,
            status: providerSession.status,
            hasProviderResume: hasProviderResumeHandle(providerSession),
            createdAt: providerSession.createdAt,
            updatedAt: providerSession.updatedAt,
          }
        : null,
    };
  }

  async listMessages(input: {
    appId: string;
    sessionId: string;
    limit: number;
  }): Promise<{ messages: unknown[] }> {
    const session = await this.requireSession(input);
    if (!session.conversationId) return { messages: [] };
    const messages = await this.deps.repositories.messages.listRecentMessages({
      conversationId: session.conversationId as never,
      limit: input.limit,
    });
    return { messages };
  }

  async listRuns(input: {
    appId: string;
    sessionId: string;
    limit: number;
  }): Promise<{ runs: unknown[] }> {
    const appSession = await this.requireSession(input);
    const session = await this.deps.repositories.agentSessions.getAgentSession(
      appSession.sessionId as never,
    );
    if (!session) return { runs: [] };
    const runs = await this.deps.repositories.agentRuns.listAgentRunsBySession({
      sessionId: session.id,
      limit: input.limit,
    });
    return { runs };
  }

  /** Verifies app ownership and returns the queue key for cancellation. */
  async getQueueKey(input: {
    appId: string;
    sessionId: string;
    threadId?: string | null;
  }): Promise<string> {
    const session = await this.requireSession(input);
    return makeSessionQueueKey(session.conversationJid, input.threadId ?? null);
  }

  async acceptMessage(input: {
    appId: string;
    sessionId: string;
    idempotencyKey?: string;
    queuePolicy?: SdkSessionQueuePolicy;
    message: string;
    senderId?: string;
    senderName?: string;
    threadId?: string;
    correlationId?: string | null;
    responseMode?: unknown;
    webhookId?: string | null;
    responseSchema?: Record<string, unknown>;
    agentControls?: AgentControlOverrides;
    callerResolvedTools?: CallerResolvedToolsConfig;
    continuityMode?: SessionContinuityMode;
    durableLiveAdmission?: boolean;
    beforeDurableAdmission?: () => Promise<void> | void;
  }): Promise<{
    accepted: true;
    replayed: boolean;
    messageId: string;
    acceptedEventId: number;
    enqueue: SessionQueueIntent;
  }> {
    const session = await this.requireSession(input);
    const agentSession =
      await this.deps.repositories.agentSessions.getAgentSession(
        session.sessionId as never,
      );
    if (!agentSession) {
      throw new ApplicationError('NOT_FOUND', 'Session not found');
    }
    if (agentSession.status === 'archived') {
      throw new ApplicationError('CONFLICT', 'Session is archived');
    }
    const text = input.message.trim();
    if (!text) {
      throw new ApplicationError('INVALID_REQUEST', 'message is required');
    }
    const idempotencyKey = input.idempotencyKey?.trim() ?? '';
    if (idempotencyKey.length > 200) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'idempotencyKey must contain at most 200 characters',
      );
    }
    const threadId = input.threadId?.trim() || null;
    const responseMode = normalizeResponseMode(
      input.responseMode,
      session.defaultResponseMode,
    );
    const webhookId = await this.resolveOwnedWebhookId(
      input.appId,
      input.webhookId ?? session.defaultWebhookId,
    );
    const requestFingerprint = idempotencyKey
      ? this.deps.stableHash(
          canonicalJson({
            appId: input.appId,
            sessionId: input.sessionId,
            message: text,
            senderId: input.senderId ?? 'sdk',
            senderName: input.senderName ?? 'SDK',
            threadId,
            correlationId: input.correlationId ?? null,
            responseMode,
            webhookId,
            responseSchema: input.responseSchema ?? null,
            agentControls: input.agentControls ?? null,
            callerResolvedTools: input.callerResolvedTools ?? null,
            continuityMode: input.continuityMode ?? 'provider',
            queuePolicy: input.queuePolicy ?? null,
          }),
        )
      : null;
    const now = this.deps.now();
    const messageId = this.deps.createId();
    const message: NewMessage = {
      id: messageId,
      chat_jid: session.conversationJid,
      provider: 'app',
      sender: input.senderId ?? 'sdk',
      sender_name: input.senderName ?? 'SDK',
      content: text,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
      external_message_id: messageId,
      thread_id: threadId ?? undefined,
      responseSchema: input.responseSchema,
      agentControls: input.agentControls,
      callerResolvedTools: input.callerResolvedTools,
      continuityMode: input.continuityMode,
      appResponseRoute: {
        sessionId: session.sessionId,
        threadId,
        responseMode,
        webhookId,
        correlationId: input.correlationId ?? null,
      },
    };
    await this.deps.ops.storeChatMetadata(
      session.conversationJid,
      now,
      session.title ?? session.conversationJid,
      'app',
      true,
    );
    const acceptedEvent: RuntimeEventPublishInput = {
      appId: session.appId as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
      payload: {
        messageId,
        text,
        threadId,
      },
      actor: 'sdk',
      sessionId: session.sessionId as never,
      conversationId: session.conversationJid as never,
      threadId: threadId ? (threadId as never) : undefined,
      correlationId: input.correlationId ?? null,
      responseMode,
      webhookId,
    };
    let durableAdmissionCreated = false;
    let admissionResult: LiveAdmissionWorkItemEnqueueResult | undefined;
    let accepted: RuntimeEvent;
    const runtimeEventsWithLiveAdmission = this.deps.runtimeEvents as {
      publishWithLiveAdmissionMessage?: RuntimeEventExchange['publishWithLiveAdmissionMessage'];
    };
    const publishWithLiveAdmissionMessage =
      runtimeEventsWithLiveAdmission.publishWithLiveAdmissionMessage?.bind(
        this.deps.runtimeEvents,
      );
    const useDurableAdmission =
      input.durableLiveAdmission !== false &&
      publishWithLiveAdmissionMessage &&
      this.deps.liveAdmissionAppId !== null;
    if (useDurableAdmission) {
      await input.beforeDurableAdmission?.();
      const liveAdmissionAppId = this.deps.liveAdmissionAppId ?? session.appId;
      const result = await publishWithLiveAdmissionMessage(acceptedEvent, {
        message,
        liveAdmission: {
          appId: liveAdmissionAppId,
          agentId: session.agentId,
          agentSessionId: session.sessionId,
          ...(idempotencyKey && requestFingerprint
            ? {
                sdkSessionAdmissionRequest: {
                  requestMessageId: messageId,
                  idempotencyKey,
                  requestFingerprint,
                  queuePolicy: input.queuePolicy,
                },
              }
            : {}),
          triggerDecision: {
            source: 'sdk_session',
            responseMode,
          },
          now,
        },
      });
      if (result.outcome === 'replayed') {
        return {
          accepted: true,
          replayed: true,
          messageId: result.messageId,
          acceptedEventId: result.acceptedEventId,
          enqueue: {
            conversationJid: session.conversationJid,
            threadId,
            queueKey: makeSessionQueueKey(session.conversationJid, threadId),
            durableAdmissionCreated: true,
          },
        };
      }
      if (result.outcome === 'fingerprint_conflict') {
        throw new ApplicationError(
          'SESSION_IDEMPOTENCY_CONFLICT',
          'The idempotency key was already used for a different session message.',
        );
      }
      if (result.outcome === 'capacity_exceeded') {
        throw new ApplicationError(
          'SESSION_QUEUE_FULL',
          'The private session already has the maximum number of active and waiting messages.',
        );
      }
      accepted = result.event;
      admissionResult = result.liveAdmissionResult;
      durableAdmissionCreated = !!admissionResult;
    } else {
      await this.deps.ops.storeMessage(message);
      accepted = await this.deps.runtimeEvents.publish(acceptedEvent);
    }
    if (admissionResult) {
      await this.deps.ops.notifyLiveAdmissionWorkItem?.(admissionResult);
    }
    return {
      accepted: true,
      replayed: false,
      messageId,
      acceptedEventId: accepted.eventId,
      enqueue: {
        conversationJid: session.conversationJid,
        threadId,
        queueKey: makeSessionQueueKey(session.conversationJid, threadId),
        durableAdmissionCreated,
      },
    };
  }

  async archiveSession(input: { appId: string; sessionId: string }): Promise<{
    archived: true;
    alreadyArchived: boolean;
    queueKey: string;
    queueKeys: string[];
  }> {
    const appSession = await this.requireSession(input);
    const session = await this.deps.repositories.agentSessions.getAgentSession(
      appSession.sessionId as never,
    );
    if (!session) {
      throw new ApplicationError('NOT_FOUND', 'Session not found');
    }
    const alreadyArchived = session.status === 'archived';
    const updatedAt = this.deps.now();
    if (!alreadyArchived) {
      await this.deps.repositories.agentSessions.saveAgentSession({
        ...session,
        status: 'archived',
        updatedAt,
      });
    }
    const providerSession =
      await this.deps.repositories.providerSessions.getLatestProviderSession({
        agentSessionId: session.id,
      });
    if (providerSession && providerSession.status !== 'expired') {
      await this.deps.repositories.providerSessions.markProviderSessionStatus(
        providerSession.id,
        'expired',
        updatedAt,
      );
    }
    const threadIds = await this.deps.ops.getMessageThreadIds(
      appSession.conversationJid,
    );
    const queueKeys = Array.from(
      new Set([
        makeSessionQueueKey(appSession.conversationJid),
        ...threadIds.map((threadId) =>
          makeSessionQueueKey(appSession.conversationJid, threadId),
        ),
      ]),
    );
    return {
      archived: true,
      alreadyArchived,
      queueKey: queueKeys[0]!,
      queueKeys,
    };
  }

  async listEvents(input: {
    appId: string;
    sessionId: string;
    afterEventId?: number;
    limit?: number;
  }): Promise<RuntimeEvent[]> {
    const session = await this.requireSession(input);
    return this.deps.runtimeEvents.list(this.eventFilter(session, input));
  }

  async subscribeEvents(input: {
    appId: string;
    sessionId: string;
    afterEventId?: number;
    limit?: number;
  }) {
    const session = await this.requireSession(input);
    return this.deps.runtimeEvents.subscribe(this.eventFilter(session, input));
  }

  async waitForVisibleEvent(input: {
    appId: string;
    sessionId: string;
    afterEventId?: number;
    timeoutMs: number;
  }): Promise<RuntimeEvent> {
    const subscription = await this.subscribeEvents(input);
    const startedAt = currentTimeMs();
    try {
      while (currentTimeMs() - startedAt < input.timeoutMs) {
        const remaining = input.timeoutMs - (currentTimeMs() - startedAt);
        const events = await subscription.next({ timeoutMs: remaining });
        const visible = events.find(isVisibleWaitEvent);
        if (visible) return visible;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      subscription.close();
    }
    throw new ApplicationError(
      'WAIT_TIMEOUT',
      'Timed out waiting for session event',
    );
  }

  async publishOutboundEvent(input: {
    conversationJid: string;
    eventType: RuntimeEventPublishInput['eventType'];
    payload: Record<string, unknown>;
    runId?: string;
    appResponseRoute?: AppMessageResponseRoute;
  }): Promise<{ emitted: boolean; eventId?: number }> {
    const session = await this.deps.control.getAppSessionByChatJid(
      input.conversationJid,
    );
    if (!session) return { emitted: false };
    const threadId =
      typeof input.payload.threadId === 'string'
        ? input.payload.threadId
        : null;
    if (
      input.appResponseRoute &&
      input.appResponseRoute.sessionId !== session.sessionId
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'App response route does not match the outbound session',
      );
    }
    const route =
      input.appResponseRoute ??
      (await this.deps.control.getAppResponseRoute({
        sessionId: session.sessionId,
        threadId,
      }));
    const event = await this.deps.runtimeEvents.publish({
      appId: session.appId as never,
      eventType: input.eventType,
      payload: input.payload,
      actor: 'agent',
      sessionId: session.sessionId as never,
      ...(input.runId ? { runId: input.runId as never } : {}),
      conversationId: session.conversationJid as never,
      threadId: threadId ? (threadId as never) : undefined,
      correlationId: route?.correlationId ?? null,
      responseMode: route?.responseMode ?? session.defaultResponseMode,
      webhookId: route ? route.webhookId : session.defaultWebhookId,
    });
    return { emitted: true, eventId: event.eventId };
  }

  private async requireSession(input: {
    appId: string;
    sessionId: string;
  }): Promise<SessionAppRecord> {
    const session = await this.deps.control.getAppSessionById(input.sessionId);
    if (!session) {
      throw new ApplicationError('NOT_FOUND', 'Session not found');
    }
    if (session.appId !== input.appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this session',
      );
    }
    return session;
  }

  private async resolveOwnedWebhookId(
    appId: string,
    rawWebhookId: string | null,
  ): Promise<string | null> {
    const webhookId = rawWebhookId?.trim();
    if (!webhookId) return null;
    const webhook = await this.deps.control.getWebhookById(webhookId, appId);
    if (!webhook) {
      throw new ApplicationError('NOT_FOUND', 'Webhook not found');
    }
    return webhook.webhookId;
  }

  private eventFilter(
    session: SessionAppRecord,
    input: { afterEventId?: number; limit?: number },
  ): RuntimeEventFilter {
    return {
      appId: session.appId as never,
      sessionId: session.sessionId as never,
      afterEventId:
        input.afterEventId && input.afterEventId > 0
          ? (input.afterEventId as never)
          : undefined,
      limit: input.limit ?? 100,
    };
  }
}

export function assertAppScope(
  resolvedAppId: string,
  assertedAppId?: string | null,
): void {
  const trimmed = assertedAppId?.trim();
  if (trimmed && trimmed !== resolvedAppId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Request appId does not match authenticated app scope',
    );
  }
}

export function normalizeResponseMode(
  raw: unknown,
  fallback: ControlResponseMode,
): ControlResponseMode {
  return raw === 'webhook' || raw === 'both' || raw === 'none' || raw === 'sse'
    ? raw
    : fallback;
}

type AppGroupRegistration = {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger: boolean;
};

export function makeAppGroup(input: {
  appId: string;
  conversationId: string;
  conversationJid: string;
  identityHash: string;
  addedAt: string;
}): AppGroupRegistration {
  const app = sanitizeSegment(input.appId) || 'app';
  const conversation = sanitizeSegment(input.conversationId) || 'session';
  const prefix = `app_${input.identityHash}_`;
  const remaining = MAX_WORKSPACE_FOLDER_LENGTH - prefix.length;
  const appPart = app.slice(0, Math.max(8, Math.floor(remaining * 0.4)));
  const conversationPart = conversation.slice(
    0,
    Math.max(8, remaining - appPart.length - 1),
  );
  return {
    name: `${input.appId}:${input.conversationId}`,
    folder: `${prefix}${appPart}_${conversationPart}`.slice(
      0,
      MAX_WORKSPACE_FOLDER_LENGTH,
    ),
    trigger: '',
    added_at: input.addedAt,
    requiresTrigger: false,
  };
}

export function makeSessionQueueKey(
  conversationJid: string,
  threadId?: string | null,
): string {
  const normalized = threadId?.trim();
  if (!normalized) return conversationJid;
  return `${conversationJid}::thread:${encodeURIComponent(normalized)}`;
}

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function isVisibleWaitEvent(event: RuntimeEvent): boolean {
  return (
    event.eventType === RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND ||
    event.eventType === RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING
  );
}

function hasProviderResumeHandle(value: {
  externalSessionId?: unknown;
  providerRef?: { value?: unknown } | null;
  metadata?: unknown;
}): boolean {
  return (
    hasNonEmptyString(value.externalSessionId) ||
    hasNonEmptyString(value.providerRef?.value) ||
    metadataContainsResumeHandle(value.metadata, 0)
  );
}

function metadataContainsResumeHandle(value: unknown, depth: number): boolean {
  if (depth > 4 || value == null) return false;
  if (Array.isArray(value)) {
    return value.some((entry) =>
      metadataContainsResumeHandle(entry, depth + 1),
    );
  }
  if (typeof value !== 'object') return false;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /(externalSessionId|providerSessionId|latestProviderSessionId|newSessionId|sessionId|session_id|resume|artifact)/i.test(
        key,
      ) &&
      hasNonEmptyString(entry)
    ) {
      return true;
    }
    if (metadataContainsResumeHandle(entry, depth + 1)) {
      return true;
    }
  }
  return false;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
