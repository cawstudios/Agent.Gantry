import { randomUUID } from 'node:crypto';

import type { AppId } from '../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { NewMessage } from '../../domain/types.js';
import { formatOutboundForChannel } from '../../messaging/router.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  canonicalConversationIdForJid,
  canonicalThreadIdFor,
} from './runtime-services-destination-hints.js';

type ConversationOutboundEventLogger = {
  warn(context: Record<string, unknown>, message: string): void;
};

type ConversationOutboundDeliveryStatus = 'sent' | 'failed' | 'partially_sent';

export function createConversationOutboundProjection(input: {
  rawText: string;
  channelName: string;
  providerId: string;
  providerAccountId?: string;
  conversationJid: string;
  threadId?: string;
  appId: AppId;
  messageId?: string;
  attemptCount?: number;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown>;
  logger: ConversationOutboundEventLogger;
}):
  | {
      formatted: string;
      provider: string;
      messageId: string;
      baseMessage: NewMessage;
      publishEvent(input: {
        deliveryStatus: ConversationOutboundDeliveryStatus;
        externalMessageId?: string;
        error?: string;
        terminal?: boolean;
      }): Promise<void>;
    }
  | undefined {
  const formatted = formatOutboundForChannel(input.rawText, input.providerId);
  if (!formatted) return undefined;

  const now = nowIso();
  const messageId = input.messageId?.trim() || `outbound:${randomUUID()}`;
  const baseMessage: NewMessage = {
    id: messageId,
    chat_jid: input.conversationJid,
    provider: input.providerId,
    providerAccountId: input.providerAccountId,
    sender: 'gantry',
    sender_name: 'Gantry',
    content: formatted,
    timestamp: now,
    is_from_me: true,
    is_bot_message: true,
    thread_id: input.threadId,
  };

  return {
    formatted,
    provider: input.providerId || input.channelName,
    messageId,
    baseMessage,
    publishEvent: async (eventInput) => {
      if (!input.publishRuntimeEvent) return;
      try {
        const conversationId = canonicalConversationIdForJid(
          input.conversationJid,
          input.providerAccountId,
        );
        const threadId = canonicalThreadIdFor({
          jid: input.conversationJid,
          threadId: input.threadId,
          providerAccountId: input.providerAccountId,
        });
        await input.publishRuntimeEvent({
          appId: input.appId,
          conversationId: conversationId as never,
          ...(threadId ? { threadId: threadId as never } : {}),
          eventType: RUNTIME_EVENT_TYPES.CONVERSATION_MESSAGE_OUTBOUND,
          actor: 'agent',
          responseMode: 'none',
          payload: {
            messageId,
            conversationId,
            threadId: threadId ?? null,
            providerId: input.providerId,
            providerAccountId: input.providerAccountId ?? null,
            externalConversationId: input.conversationJid.replace(
              /^[^:]+:/u,
              '',
            ),
            direction: 'outbound',
            deliveryStatus: eventInput.deliveryStatus,
            attemptCount: input.attemptCount ?? 1,
            terminal:
              eventInput.terminal ?? eventInput.deliveryStatus === 'sent',
            sender: {
              id: baseMessage.sender,
              name: baseMessage.sender_name,
            },
            ...(eventInput.externalMessageId
              ? { externalMessageId: eventInput.externalMessageId }
              : {}),
            ...(eventInput.error ? { error: eventInput.error } : {}),
            text: formatted,
          },
          createdAt: nowIso(),
        });
      } catch (err) {
        input.logger.warn(
          { err, jid: input.conversationJid },
          'Failed to publish conversation outbound runtime event',
        );
      }
    },
  };
}
