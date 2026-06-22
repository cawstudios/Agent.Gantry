import { eq } from 'drizzle-orm';

import type { CanonicalDb } from '../adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import { teamsConversationReferencesPostgres } from '../adapters/storage/postgres/schema/teams.js';
import { nowIso } from '../shared/time/datetime.js';

export interface TeamsStoredConversationReference {
  conversationJid: string;
  conversationId: string;
  serviceUrl: string;
  tenantId?: string;
  botId?: string;
  rawReferenceJson: string;
  updatedAt?: string;
}

export interface TeamsConversationReferenceStore {
  save(reference: TeamsStoredConversationReference): Promise<void>;
  get(
    conversationJid: string,
  ): Promise<TeamsStoredConversationReference | null>;
}

export class PostgresTeamsConversationReferenceStore implements TeamsConversationReferenceStore {
  constructor(private readonly db: CanonicalDb) {}

  async save(reference: TeamsStoredConversationReference): Promise<void> {
    await this.db
      .insert(teamsConversationReferencesPostgres)
      .values({
        conversationJid: reference.conversationJid,
        conversationId: reference.conversationId,
        serviceUrl: reference.serviceUrl,
        tenantId: reference.tenantId ?? null,
        botId: reference.botId ?? null,
        rawReferenceJson: reference.rawReferenceJson,
        updatedAt: reference.updatedAt ?? nowIso(),
      })
      .onConflictDoUpdate({
        target: teamsConversationReferencesPostgres.conversationJid,
        set: {
          conversationId: reference.conversationId,
          serviceUrl: reference.serviceUrl,
          tenantId: reference.tenantId ?? null,
          botId: reference.botId ?? null,
          rawReferenceJson: reference.rawReferenceJson,
          updatedAt: reference.updatedAt ?? nowIso(),
        },
      });
  }

  async get(
    conversationJid: string,
  ): Promise<TeamsStoredConversationReference | null> {
    const row = (
      await this.db
        .select()
        .from(teamsConversationReferencesPostgres)
        .where(
          eq(
            teamsConversationReferencesPostgres.conversationJid,
            conversationJid,
          ),
        )
        .limit(1)
    )[0];
    if (!row) return null;
    return {
      conversationJid: row.conversationJid,
      conversationId: row.conversationId,
      serviceUrl: row.serviceUrl,
      tenantId: row.tenantId ?? undefined,
      botId: row.botId ?? undefined,
      rawReferenceJson: row.rawReferenceJson,
      updatedAt: row.updatedAt,
    };
  }
}
