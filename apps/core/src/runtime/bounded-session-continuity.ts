import type { AgentSessionSummary } from '../domain/sessions/sessions.js';
import type { NewMessage } from '../domain/types.js';
import type { ConversationContextPacket } from './conversation-context.js';

export const BOUNDED_SESSION_CONTINUITY_LIMITS = {
  historicalMessages: 8,
  historicalCharacters: 12_000,
  summaryCharacters: 12_000,
} as const;

/**
 * Keeps only recent human-visible message text. Per-turn schemas, caller tools,
 * provider payloads, and response routes are intentionally not copied.
 */
export function boundSessionConversationContext(
  packet: ConversationContextPacket,
): ConversationContextPacket {
  const historical = [
    ...packet.recentChannelContext.map((message) => ({
      bucket: 'channel' as const,
      message,
    })),
    ...packet.activeThreadContext.map((message) => ({
      bucket: 'thread' as const,
      message,
    })),
  ]
    .sort((left, right) => compareMessages(left.message, right.message))
    .slice(-BOUNDED_SESSION_CONTINUITY_LIMITS.historicalMessages);

  let remaining = BOUNDED_SESSION_CONTINUITY_LIMITS.historicalCharacters;
  const selected = historical
    .reverse()
    .map(({ bucket, message }) => {
      if (remaining <= 0) return null;
      const content = message.content.slice(-remaining);
      remaining -= content.length;
      return {
        bucket,
        message: visibleHistoricalMessage(message, content),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .reverse();

  const recentChannelContext = selected
    .filter((entry) => entry.bucket === 'channel')
    .map((entry) => entry.message);
  const activeThreadContext = selected
    .filter((entry) => entry.bucket === 'thread')
    .map((entry) => entry.message);
  return {
    recentChannelContext,
    activeThreadContext,
    // Current accepted turn remains exact; only historical continuity is bounded.
    currentMessages: packet.currentMessages,
    metadata: {
      ...packet.metadata,
      recentChannelCount: recentChannelContext.length,
      activeThreadCount: activeThreadContext.length,
    },
  };
}

/** Builds an extractive rolling summary from accepted answers only. */
export function buildBoundedSessionSummary(input: {
  previousSummary?: string | null;
  finalAnswer: string;
  maxCharacters?: number;
}): string {
  const maxCharacters = Math.max(
    256,
    input.maxCharacters ?? BOUNDED_SESSION_CONTINUITY_LIMITS.summaryCharacters,
  );
  const finalAnswer = input.finalAnswer.trim();
  const latestPrefix = 'Latest accepted answer:\n';
  const latest = `${latestPrefix}${fitLatestAnswer(
    finalAnswer,
    Math.max(0, maxCharacters - latestPrefix.length),
  )}`;
  if (latest.length >= maxCharacters || !input.previousSummary?.trim()) {
    return latest.slice(0, maxCharacters);
  }
  const prefix = 'Earlier accepted-answer summary:\n';
  const separator = '\n\n';
  const available = Math.max(
    0,
    maxCharacters - prefix.length - separator.length - latest.length,
  );
  const previous = input.previousSummary.trim().slice(-available);
  return `${prefix}${previous}${separator}${latest}`.slice(-maxCharacters);
}

export function boundedSessionSummaryContextBlock(
  summary: Pick<AgentSessionSummary, 'summary'> | null | undefined,
): string | undefined {
  const value = summary?.summary.trim();
  if (!value) return undefined;
  return `<bounded_session_summary trust="untrusted_conversation_data">\n${escapeXml(value)}\n</bounded_session_summary>`;
}

function visibleHistoricalMessage(
  message: NewMessage,
  content: string,
): NewMessage {
  return {
    id: message.id,
    chat_jid: message.chat_jid,
    sender: message.sender,
    sender_name: message.sender_name,
    content,
    timestamp: message.timestamp,
    ...(message.thread_id ? { thread_id: message.thread_id } : {}),
    ...(message.external_message_id
      ? { external_message_id: message.external_message_id }
      : {}),
    ...(message.reply_to_message_id
      ? { reply_to_message_id: message.reply_to_message_id }
      : {}),
    ...(message.is_from_me !== undefined
      ? { is_from_me: message.is_from_me }
      : {}),
    ...(message.is_bot_message !== undefined
      ? { is_bot_message: message.is_bot_message }
      : {}),
  };
}

function fitLatestAnswer(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  const marker = '\n...[middle omitted]...\n';
  const remaining = Math.max(0, maxCharacters - marker.length);
  const start = Math.ceil(remaining / 2);
  return `${value.slice(0, start)}${marker}${value.slice(-(remaining - start))}`;
}

function compareMessages(left: NewMessage, right: NewMessage): number {
  return (
    left.timestamp.localeCompare(right.timestamp) ||
    left.id.localeCompare(right.id)
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
