import { z } from 'zod';

import type { RuntimeApiTransport } from '../../lib/api/runtime-transport';
import type {
  ConversationDashboard,
  ConversationView,
} from '../operations/conversation-api';

const ensureSessionSchema = z.object({
  sessionId: z.string(),
  appId: z.string(),
  conversationId: z.string(),
  chatJid: z.string(),
});

const sessionSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  conversationId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  status: z.enum(['active', 'reset', 'archived']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const providerSessionSchema = z
  .object({
    provider: z.string(),
    status: z.enum([
      'active',
      'expired',
      'reset',
      'maintenance_compact',
      'ready',
    ]),
    hasProviderResume: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .nullable();

const sessionDetailsSchema = z.object({
  session: sessionSchema,
  providerSession: providerSessionSchema,
});

const messagePartSchema = z.object({ kind: z.string() }).passthrough();
const sessionMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  threadId: z.string().nullable().optional(),
  direction: z.enum(['inbound', 'outbound', 'system', 'tool']),
  senderDisplayName: z.string().nullable().optional(),
  trust: z.enum(['trusted', 'untrusted', 'system', 'redacted']),
  createdAt: z.string(),
  parts: z.array(messagePartSchema),
});
const sessionMessagesSchema = z.object({
  messages: z.array(sessionMessageSchema),
});

const sessionRunSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  resultSummary: z.string().optional(),
  errorSummary: z.string().optional(),
});
const sessionRunsSchema = z.object({ runs: z.array(sessionRunSchema) });

const sendMessageResponseSchema = z.object({
  accepted: z.literal(true),
  messageId: z.string(),
  acceptedEventId: z.number().int(),
});

export const sessionEventSchema = z.object({
  eventId: z.number().int(),
  eventType: z.string(),
  sessionId: z.string().nullable(),
  threadId: z.string().nullable(),
  correlationId: z.string().nullable(),
  createdAt: z.string(),
  payload: z.unknown(),
});

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  author: string;
  content: string;
  createdAt: string;
};

export type ChatRun = z.infer<typeof sessionRunSchema>;

export type ChatSession = {
  id: string;
  title: string;
  agent: string;
  conversation: string;
  conversationId?: string;
  threadId?: string;
  status: z.infer<typeof sessionSchema>['status'];
  providerSession: z.infer<typeof providerSessionSchema>;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  runs: ChatRun[];
};

export const chatQueryKeys = {
  all: ['chat'] as const,
  session: (sessionId: string) =>
    [...chatQueryKeys.all, 'session', sessionId] as const,
};

export function ensureChatSession(
  transport: RuntimeApiTransport,
  appId: string,
  conversation: ConversationView,
) {
  return transport.request({
    path: '/sessions/ensure',
    method: 'POST',
    body: {
      appId,
      conversationId: conversation.id,
      title: conversation.name,
      responseMode: 'sse',
    },
    schema: ensureSessionSchema,
  });
}

export async function loadChatSession(
  transport: RuntimeApiTransport,
  sessionId: string,
  dashboard: ConversationDashboard,
): Promise<ChatSession> {
  const encodedId = encodeURIComponent(sessionId);
  const [details, messages, runs] = await Promise.all([
    transport.request({
      path: `/sessions/${encodedId}`,
      schema: sessionDetailsSchema,
    }),
    transport.request({
      path: `/sessions/${encodedId}/messages`,
      query: { limit: 200 },
      schema: sessionMessagesSchema,
    }),
    transport.request({
      path: `/sessions/${encodedId}/runs`,
      query: { limit: 100 },
      schema: sessionRunsSchema,
    }),
  ]);
  const conversation = dashboard.conversations.find(
    (item) => item.id === details.session.conversationId,
  );
  const agent = dashboard.agents.find(
    (item) => item.id === details.session.agentId,
  );
  return {
    id: details.session.id,
    title: conversation?.name ?? details.session.id,
    agent: agent?.name ?? details.session.agentId,
    conversation: conversation?.provider ?? 'Unavailable',
    conversationId: details.session.conversationId ?? undefined,
    threadId: details.session.threadId ?? undefined,
    status: details.session.status,
    providerSession: details.providerSession,
    createdAt: details.session.createdAt,
    updatedAt: details.session.updatedAt,
    messages: messages.messages.map(mapMessage),
    runs: runs.runs,
  };
}

export function sendChatMessage(
  transport: RuntimeApiTransport,
  input: { sessionId: string; message: string; threadId?: string },
) {
  return transport.request({
    path: `/sessions/${encodeURIComponent(input.sessionId)}/messages`,
    method: 'POST',
    body: {
      message: input.message,
      senderId: 'ui-local-owner',
      senderName: 'Local owner',
      threadId: input.threadId,
      responseMode: 'sse',
    },
    schema: sendMessageResponseSchema,
  });
}

export function streamChatEvents(
  transport: RuntimeApiTransport,
  sessionId: string,
  afterEventId: number,
  signal: AbortSignal,
) {
  return transport.stream({
    path: `/sessions/${encodeURIComponent(sessionId)}/events`,
    query: { afterEventId },
    schema: sessionEventSchema,
    signal,
  });
}

export function visibleEventText(event: SessionEvent): string | null {
  if (
    event.eventType !== 'session.message.streaming' &&
    event.eventType !== 'session.message.outbound'
  ) {
    return null;
  }
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const kind =
    typeof payload.kind === 'string' ? payload.kind.toLowerCase() : '';
  const type =
    typeof payload.type === 'string' ? payload.type.toLowerCase() : '';
  if (
    kind.includes('reason') ||
    type.includes('reason') ||
    type.includes('thinking')
  ) {
    return null;
  }
  if (payload.kind === 'rich_interaction') {
    return typeof payload.fallbackText === 'string'
      ? payload.fallbackText
      : null;
  }
  return typeof payload.text === 'string' ? payload.text : null;
}

export function isTerminalSessionEvent(event: SessionEvent): boolean {
  if (
    ['run.completed', 'run.failed', 'run.timeout', 'run.canceled'].includes(
      event.eventType,
    )
  ) {
    return true;
  }
  const payload = asRecord(event.payload);
  if (event.eventType === 'session.message.outbound') {
    return payload?.kind !== 'rich_interaction';
  }
  return (
    event.eventType === 'session.message.streaming' && payload?.done === true
  );
}

function mapMessage(
  message: z.infer<typeof sessionMessageSchema>,
): ChatMessage {
  return {
    id: message.id,
    role:
      message.direction === 'inbound'
        ? 'user'
        : message.direction === 'outbound'
          ? 'assistant'
          : 'system',
    author:
      message.senderDisplayName ??
      (message.direction === 'inbound'
        ? 'User'
        : message.direction === 'outbound'
          ? 'Gantry'
          : 'System'),
    content: readableParts(message.parts),
    createdAt: message.createdAt,
  };
}

function readableParts(parts: z.infer<typeof messagePartSchema>[]): string {
  const content = parts.flatMap((part) => {
    if (part.kind === 'text' && typeof part.text === 'string') return part.text;
    if (part.kind === 'markdown' && typeof part.markdown === 'string') {
      return part.markdown;
    }
    if (part.kind === 'code' && typeof part.code === 'string') return part.code;
    if (part.kind === 'redacted') return '[Redacted]';
    return [];
  });
  return content.join('\n\n') || 'Structured message content is not displayed.';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
