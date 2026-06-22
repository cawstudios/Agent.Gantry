import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const teamsConversationReferencesPostgres = pgTable(
  'teams_conversation_references',
  {
    conversationJid: text('conversation_jid').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    serviceUrl: text('service_url').notNull(),
    tenantId: text('tenant_id'),
    botId: text('bot_id'),
    rawReferenceJson: text('raw_reference_json').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationIdIdx: index(
      'idx_teams_conversation_references_conversation_id',
    ).on(table.conversationId),
  }),
);
