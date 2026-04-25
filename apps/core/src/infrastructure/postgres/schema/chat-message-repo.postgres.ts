import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  isNotNull,
  ne,
  or,
} from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { nowIso as currentIso } from '../../time/datetime.js';
import {
  decodeGlobalMessageCursor,
  decodeGroupMessageCursor,
  encodeGlobalMessageCursor,
  toGlobalMessageCursor,
} from '../../../shared/message-cursor.js';
import type { NewMessage } from '../../../domain/types.js';
import type { ChatInfo } from '../../../domain/repositories/domain-types.js';
import { mapMessageRow, normalizeText } from './ops-common.postgres.js';
import * as pgSchema from './schema.js';

export class PostgresChatMessageRepository {
  constructor(private readonly db: NodePgDatabase<typeof pgSchema>) {}

  async storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void> {
    const effectiveTimestamp = timestamp || currentIso();
    const chat = pgSchema.chatsPostgres;
    await this.db.transaction(async (tx) => {
      const existing = (
        await tx.select().from(chat).where(eq(chat.jid, chatJid)).limit(1)
      )[0];
      const nextLastMessageTime =
        existing?.lastMessageTime &&
        existing.lastMessageTime > effectiveTimestamp
          ? existing.lastMessageTime
          : effectiveTimestamp;
      const nextChannel =
        channel === undefined ? (existing?.channel ?? null) : channel;
      const nextIsGroup =
        isGroup === undefined ? Boolean(existing?.isGroup) : Boolean(isGroup);
      await tx
        .insert(chat)
        .values({
          jid: chatJid,
          name: name || existing?.name || chatJid,
          lastMessageTime: nextLastMessageTime,
          channel: nextChannel ?? null,
          isGroup: nextIsGroup,
        })
        .onConflictDoUpdate({
          target: chat.jid,
          set: {
            name: name || existing?.name || chatJid,
            lastMessageTime: nextLastMessageTime,
            channel: nextChannel ?? null,
            isGroup: nextIsGroup,
          },
        });
    });
  }

  async getAllChats(): Promise<ChatInfo[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.chatsPostgres)
      .orderBy(desc(pgSchema.chatsPostgres.lastMessageTime));
    return rows.map((row) => ({
      jid: row.jid,
      name: row.name || row.jid,
      last_message_time: row.lastMessageTime || '',
      channel: row.channel || '',
      is_group: row.isGroup ? 1 : 0,
    }));
  }

  async storeMessage(msg: NewMessage): Promise<void> {
    const m = pgSchema.messagesPostgres;
    await this.db
      .insert(m)
      .values({
        id: msg.id,
        chatJid: msg.chat_jid,
        sender: msg.sender,
        senderName: msg.sender_name,
        content: msg.content,
        timestamp: msg.timestamp,
        threadId: msg.thread_id ?? null,
        isFromMe: Boolean(msg.is_from_me),
        isBotMessage: Boolean(msg.is_bot_message),
        replyToMessageId: msg.reply_to_message_id ?? null,
        replyToMessageContent: msg.reply_to_message_content ?? null,
        replyToSenderName: msg.reply_to_sender_name ?? null,
      })
      .onConflictDoUpdate({
        target: [m.id, m.chatJid],
        set: {
          sender: msg.sender,
          senderName: msg.sender_name,
          content: msg.content,
          timestamp: msg.timestamp,
          threadId: msg.thread_id ?? null,
          isFromMe: Boolean(msg.is_from_me),
          isBotMessage: Boolean(msg.is_bot_message),
          replyToMessageId: msg.reply_to_message_id ?? null,
          replyToMessageContent: msg.reply_to_message_content ?? null,
          replyToSenderName: msg.reply_to_sender_name ?? null,
        },
      });
  }

  async getNewMessages(
    jids: string[],
    lastCursor: string,
    limit: number = 200,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
    if (jids.length === 0) return { messages: [], newTimestamp: lastCursor };
    const cursor = decodeGlobalMessageCursor(lastCursor);
    const m = pgSchema.messagesPostgres;
    const rows = await this.db
      .select()
      .from(m)
      .where(
        and(
          inArray(m.chatJid, jids),
          or(
            gt(m.timestamp, cursor.timestamp),
            and(
              eq(m.timestamp, cursor.timestamp),
              or(
                gt(m.chatJid, cursor.chatJid),
                and(eq(m.chatJid, cursor.chatJid), gt(m.id, cursor.id)),
              ),
            ),
          ),
          eq(m.isBotMessage, false),
          isNotNull(m.content),
          ne(m.content, ''),
        ),
      )
      .orderBy(asc(m.timestamp), asc(m.chatJid), asc(m.id))
      .limit(limit);
    const messages = rows.map((row) => mapMessageRow(row));
    const latest = messages[messages.length - 1];
    return {
      messages,
      newTimestamp: latest
        ? encodeGlobalMessageCursor(toGlobalMessageCursor(latest))
        : lastCursor,
    };
  }

  async getMessagesSince(
    chatJid: string,
    sinceCursor: string,
    limit: number = 200,
    options: { threadId?: string | null } = {},
  ): Promise<NewMessage[]> {
    const cursor = decodeGroupMessageCursor(sinceCursor);
    const m = pgSchema.messagesPostgres;
    const hasThreadFilter = Object.prototype.hasOwnProperty.call(
      options,
      'threadId',
    );
    const threadId = options.threadId?.trim() || null;
    const threadFilter = hasThreadFilter
      ? threadId
        ? eq(m.threadId, threadId)
        : or(isNull(m.threadId), eq(m.threadId, ''))
      : undefined;
    const rows = await this.db
      .select()
      .from(m)
      .where(
        and(
          eq(m.chatJid, chatJid),
          or(
            gt(m.timestamp, cursor.timestamp),
            and(eq(m.timestamp, cursor.timestamp), gt(m.id, cursor.id)),
          ),
          eq(m.isBotMessage, false),
          isNotNull(m.content),
          ne(m.content, ''),
          threadFilter,
        ),
      )
      .orderBy(asc(m.timestamp), asc(m.id))
      .limit(limit);
    return rows.map((row) => mapMessageRow(row));
  }

  async getMessageThreadIds(chatJid: string): Promise<Array<string | null>> {
    const m = pgSchema.messagesPostgres;
    const rows = await this.db
      .selectDistinct({ threadId: m.threadId })
      .from(m)
      .where(
        and(
          eq(m.chatJid, chatJid),
          eq(m.isBotMessage, false),
          isNotNull(m.content),
          ne(m.content, ''),
        ),
      )
      .orderBy(asc(m.threadId));
    const seen = new Set<string>();
    const threads: Array<string | null> = [];
    for (const row of rows) {
      const normalized = normalizeText(row.threadId);
      const key = normalized ?? '';
      if (seen.has(key)) continue;
      seen.add(key);
      threads.push(normalized);
    }
    return threads;
  }

  async getLastBotMessageCursor(
    chatJid: string,
  ): Promise<{ timestamp: string; id: string } | undefined> {
    const rows = await this.db
      .select({
        timestamp: pgSchema.messagesPostgres.timestamp,
        id: pgSchema.messagesPostgres.id,
      })
      .from(pgSchema.messagesPostgres)
      .where(
        and(
          eq(pgSchema.messagesPostgres.chatJid, chatJid),
          eq(pgSchema.messagesPostgres.isBotMessage, true),
        ),
      )
      .orderBy(
        desc(pgSchema.messagesPostgres.timestamp),
        desc(pgSchema.messagesPostgres.id),
      )
      .limit(1);
    const row = rows[0];
    if (!row || !row.timestamp) return undefined;
    return { timestamp: row.timestamp, id: row.id };
  }

  async getLastBotMessageTimestamp(
    chatJid: string,
  ): Promise<string | undefined> {
    return (await this.getLastBotMessageCursor(chatJid))?.timestamp;
  }
}
