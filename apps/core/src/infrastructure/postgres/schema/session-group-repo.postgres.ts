import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { nowIso as currentIso } from '../../time/datetime.js';
import type { RegisteredGroup } from '../../../domain/types.js';
import { isValidGroupFolder } from '../../../platform/group-folder.js';
import { makeSessionScopeKey } from '../../../domain/repositories/ops-repo.js';
import {
  ensureValidGroupFolder,
  parseRegisteredGroupAgentConfig,
} from './ops-common.postgres.js';
import * as pgSchema from './schema.js';

export class PostgresSessionGroupRepository {
  constructor(private readonly db: NodePgDatabase<typeof pgSchema>) {}

  async getRouterState(key: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ value: pgSchema.routerStatePostgres.value })
      .from(pgSchema.routerStatePostgres)
      .where(eq(pgSchema.routerStatePostgres.key, key))
      .limit(1);
    return rows[0]?.value;
  }

  async setRouterState(key: string, value: string): Promise<void> {
    await this.db
      .insert(pgSchema.routerStatePostgres)
      .values({ key, value })
      .onConflictDoUpdate({
        target: pgSchema.routerStatePostgres.key,
        set: { value },
      });
  }

  async getSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<string | undefined> {
    const rows = await this.db
      .select({ sessionId: pgSchema.sessionsPostgres.sessionId })
      .from(pgSchema.sessionsPostgres)
      .where(
        eq(
          pgSchema.sessionsPostgres.scopeKey,
          makeSessionScopeKey(groupFolder, threadId),
        ),
      )
      .limit(1);
    return rows[0]?.sessionId;
  }

  async setSession(
    groupFolder: string,
    sessionId: string,
    threadId?: string | null,
  ): Promise<void> {
    const normalizedThreadId = threadId?.trim() || null;
    await this.db
      .insert(pgSchema.sessionsPostgres)
      .values({
        scopeKey: makeSessionScopeKey(groupFolder, normalizedThreadId),
        groupFolder,
        threadId: normalizedThreadId,
        sessionId,
      })
      .onConflictDoUpdate({
        target: pgSchema.sessionsPostgres.scopeKey,
        set: { groupFolder, threadId: normalizedThreadId, sessionId },
      });
  }

  async deleteSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<void> {
    await this.db
      .delete(pgSchema.sessionsPostgres)
      .where(
        eq(
          pgSchema.sessionsPostgres.scopeKey,
          makeSessionScopeKey(groupFolder, threadId),
        ),
      );
  }

  async deleteSessionsByGroupFolder(groupFolder: string): Promise<void> {
    if (!isValidGroupFolder(groupFolder)) {
      throw new Error(`Invalid group folder "${groupFolder}"`);
    }
    await this.db
      .delete(pgSchema.sessionsPostgres)
      .where(eq(pgSchema.sessionsPostgres.groupFolder, groupFolder));
  }

  async getAllSessions(): Promise<Record<string, string>> {
    const rows = await this.db.select().from(pgSchema.sessionsPostgres);
    const result: Record<string, string> = {};
    for (const row of rows) result[row.scopeKey] = row.sessionId;
    return result;
  }

  async getRegisteredGroup(
    jid: string,
  ): Promise<(RegisteredGroup & { jid: string }) | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.registeredGroupsPostgres)
      .where(eq(pgSchema.registeredGroupsPostgres.jid, jid))
      .limit(1);
    const row = rows[0];
    if (!row || !ensureValidGroupFolder(row.jid, row.folder)) {
      return undefined;
    }
    return {
      jid: row.jid,
      name: row.name,
      folder: row.folder,
      trigger: row.triggerPattern,
      added_at: row.addedAt,
      agentConfig: parseRegisteredGroupAgentConfig(row.containerConfig, {
        jid: row.jid,
        folder: row.folder,
      }),
      requiresTrigger:
        row.requiresTrigger === null ? undefined : row.requiresTrigger === true,
      isMain: row.isMain === true ? true : undefined,
    };
  }

  async setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
    if (!isValidGroupFolder(group.folder)) {
      throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
    }
    await this.db
      .insert(pgSchema.registeredGroupsPostgres)
      .values({
        jid,
        name: group.name,
        folder: group.folder,
        triggerPattern: group.trigger,
        addedAt: group.added_at || currentIso(),
        containerConfig: group.agentConfig
          ? JSON.stringify(group.agentConfig)
          : null,
        requiresTrigger:
          group.requiresTrigger === undefined
            ? true
            : Boolean(group.requiresTrigger),
        isMain: Boolean(group.isMain),
      })
      .onConflictDoUpdate({
        target: pgSchema.registeredGroupsPostgres.jid,
        set: {
          name: group.name,
          folder: group.folder,
          triggerPattern: group.trigger,
          addedAt: group.added_at || currentIso(),
          containerConfig: group.agentConfig
            ? JSON.stringify(group.agentConfig)
            : null,
          requiresTrigger:
            group.requiresTrigger === undefined
              ? true
              : Boolean(group.requiresTrigger),
          isMain: Boolean(group.isMain),
        },
      });
  }

  async deleteRegisteredGroup(jid: string): Promise<void> {
    await this.db
      .delete(pgSchema.registeredGroupsPostgres)
      .where(eq(pgSchema.registeredGroupsPostgres.jid, jid));
  }

  async getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
    const rows = await this.db.select().from(pgSchema.registeredGroupsPostgres);
    const result: Record<string, RegisteredGroup> = {};
    for (const row of rows) {
      if (!ensureValidGroupFolder(row.jid, row.folder)) continue;
      result[row.jid] = {
        name: row.name,
        folder: row.folder,
        trigger: row.triggerPattern,
        added_at: row.addedAt,
        agentConfig: parseRegisteredGroupAgentConfig(row.containerConfig, {
          jid: row.jid,
          folder: row.folder,
        }),
        requiresTrigger:
          row.requiresTrigger === null
            ? undefined
            : row.requiresTrigger === true,
        isMain: row.isMain === true ? true : undefined,
      };
    }
    return result;
  }
}
