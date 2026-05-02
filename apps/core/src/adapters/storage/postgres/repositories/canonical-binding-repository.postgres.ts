import { asc, eq } from 'drizzle-orm';

import type { RegisteredGroup } from '../../../../domain/repositories/domain-types.js';
import { nowIso as currentIso } from '../../../../infrastructure/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  json,
  parseJson,
  PostgresCanonicalGraphRepository,
} from './canonical-graph-repository.postgres.js';

export interface CanonicalBindingRecord {
  memorySubjectJson: string;
  displayName: string;
  triggerPattern: string | null;
  requiresTrigger: boolean;
  isAdminBinding: boolean;
  createdAt: string;
}

export class PostgresCanonicalBindingRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async saveRegisteredGroup(
    jid: string,
    group: RegisteredGroup,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const conversationId = await this.graph.ensureConversation(
        jid,
        { name: group.name, isGroup: group.requiresTrigger !== false },
        tx,
      );
      const agentId = await this.graph.ensureAgent(
        group.folder,
        group.name,
        tx,
      );
      const providerConnectionId =
        await this.graph.getConversationInstallationId(conversationId, tx);
      if (!providerConnectionId) return;
      const now = group.added_at || currentIso();
      await tx
        .insert(pgSchema.agentConversationBindingsPostgres)
        .values({
          id: `binding:${jid}`,
          appId: CANONICAL_APP_ID,
          agentId,
          providerConnectionId,
          conversationId,
          displayName: group.name,
          status: 'active',
          triggerMode: group.requiresTrigger === false ? 'always' : 'keyword',
          triggerPattern: group.trigger,
          requiresTrigger: group.requiresTrigger ?? true,
          isAdminBinding: Boolean(group.isMain),
          memoryScope: 'conversation',
          memorySubjectJson: json({ jid, group }),
          permissionPolicyIdsJson: '[]',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pgSchema.agentConversationBindingsPostgres.id,
          set: {
            displayName: group.name,
            status: 'active',
            triggerMode: group.requiresTrigger === false ? 'always' : 'keyword',
            triggerPattern: group.trigger,
            requiresTrigger: group.requiresTrigger ?? true,
            isAdminBinding: Boolean(group.isMain),
            memoryScope: 'conversation',
            memorySubjectJson: json({ jid, group }),
            updatedAt: now,
          },
        });
    });
  }

  async deleteRegisteredGroup(jid: string): Promise<void> {
    await this.db
      .delete(pgSchema.agentConversationBindingsPostgres)
      .where(
        eq(pgSchema.agentConversationBindingsPostgres.id, `binding:${jid}`),
      );
  }

  async listRegisteredGroups(): Promise<CanonicalBindingRecord[]> {
    return this.db
      .select({
        memorySubjectJson:
          pgSchema.agentConversationBindingsPostgres.memorySubjectJson,
        displayName: pgSchema.agentConversationBindingsPostgres.displayName,
        triggerPattern:
          pgSchema.agentConversationBindingsPostgres.triggerPattern,
        requiresTrigger:
          pgSchema.agentConversationBindingsPostgres.requiresTrigger,
        isAdminBinding:
          pgSchema.agentConversationBindingsPostgres.isAdminBinding,
        createdAt: pgSchema.agentConversationBindingsPostgres.createdAt,
      })
      .from(pgSchema.agentConversationBindingsPostgres)
      .orderBy(asc(pgSchema.agentConversationBindingsPostgres.createdAt));
  }
}

export function bindingRowToGroup(
  row: CanonicalBindingRecord,
): { jid: string; group: RegisteredGroup } | undefined {
  const subject = parseJson<{ jid?: string; group?: RegisteredGroup }>(
    row.memorySubjectJson,
    {},
  );
  if (!subject.jid) return undefined;
  return {
    jid: subject.jid,
    group: {
      name: subject.group?.name || row.displayName,
      folder: subject.group?.folder || subject.jid,
      trigger: subject.group?.trigger || row.triggerPattern || '',
      added_at: subject.group?.added_at || row.createdAt,
      agentConfig: subject.group?.agentConfig,
      requiresTrigger: row.requiresTrigger,
      isMain: row.isAdminBinding || undefined,
    },
  };
}
