/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { cosineDistance } from 'drizzle-orm/sql/functions';

import {
  MEMORY_CHUNK_RETENTION_DAYS,
  MEMORY_ITEM_MAX_PER_GROUP,
  MEMORY_MAX_CHUNKS_PER_GROUP,
  MEMORY_MAX_EVENTS,
  MEMORY_MAX_GLOBAL_CHUNKS,
  MEMORY_MAX_PROCEDURES_PER_GROUP,
} from '../../config/index.js';
import * as pgSchema from '../../infrastructure/postgres/schema/schema.js';
import {
  MEMORY_GLOBAL_GROUP_FOLDER,
  type MemoryChunk,
  type MemoryItem,
  type MemoryProcedure,
  type MemoryScope,
  type MemorySearchResult,
  type SimilarMemoryItemMatch,
} from '../memory-types.js';
import {
  MemoryStore,
  type ChunkInsert,
  type RetentionPolicyResult,
} from './store.js';
import {
  clamp01,
  likePattern,
  nowIso,
  parseEmbedding,
  parseJsonArray,
  STALE_PATCH_MESSAGE_PREFIX,
} from './store-utils.js';
import { toChunk, toItem, toProcedure } from './row-mappers.js';

export async function applyRetentionPolicies(
  this: MemoryStore,
  groupFolder: string,
): Promise<RetentionPolicyResult> {
  const removedItemIds: string[] = [];
  const removedProcedureIds: string[] = [];
  const evictedChunkIds: string[] = [];
  const maxChunks =
    groupFolder === MEMORY_GLOBAL_GROUP_FOLDER
      ? MEMORY_MAX_GLOBAL_CHUNKS
      : MEMORY_MAX_CHUNKS_PER_GROUP;
  const cutoff = new Date(
    Date.now() - MEMORY_CHUNK_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  const c = pgSchema.memoryChunksPostgres;
  const oldChunks = await this.db
    .delete(c)
    .where(and(eq(c.groupFolder, groupFolder), sql`${c.createdAt} < ${cutoff}`))
    .returning({ id: c.id });
  evictedChunkIds.push(...oldChunks.map((row) => row.id));
  const overflowChunks = await this.db
    .select({ id: c.id })
    .from(c)
    .where(eq(c.groupFolder, groupFolder))
    .orderBy(desc(c.importanceWeight), desc(c.updatedAt))
    .offset(maxChunks);
  if (overflowChunks.length > 0) {
    await this.db.delete(c).where(
      inArray(
        c.id,
        overflowChunks.map((row) => row.id),
      ),
    );
    evictedChunkIds.push(...overflowChunks.map((row) => row.id));
  }
  const i = pgSchema.memoryItemsPostgres;
  const activeItemCountRows = await this.db
    .select({ total: sql<number>`count(*)::int` })
    .from(i)
    .where(and(eq(i.isDeleted, false), eq(i.groupFolder, groupFolder)));
  const activeItemCount = Number(activeItemCountRows[0]?.total ?? 0);
  const itemOverflowCount = Math.max(
    0,
    activeItemCount - MEMORY_ITEM_MAX_PER_GROUP,
  );
  const overflowItems = await this.db
    .select({ id: i.id })
    .from(i)
    .where(
      and(
        eq(i.isDeleted, false),
        eq(i.groupFolder, groupFolder),
        eq(i.isPinned, false),
        eq(i.loadBearing, false),
      ),
    )
    .orderBy(asc(i.confidence), asc(i.updatedAt))
    .limit(itemOverflowCount);
  for (const row of overflowItems) {
    await this.softDeleteItem(row.id);
    removedItemIds.push(row.id);
  }
  const p = pgSchema.memoryProceduresPostgres;
  const activeProcedureCountRows = await this.db
    .select({ total: sql<number>`count(*)::int` })
    .from(p)
    .where(and(eq(p.isDeleted, false), eq(p.groupFolder, groupFolder)));
  const activeProcedureCount = Number(activeProcedureCountRows[0]?.total ?? 0);
  const procedureOverflowCount = Math.max(
    0,
    activeProcedureCount - MEMORY_MAX_PROCEDURES_PER_GROUP,
  );
  const overflowProcedures = await this.db
    .select({ id: p.id })
    .from(p)
    .where(and(eq(p.isDeleted, false), eq(p.groupFolder, groupFolder)))
    .orderBy(
      asc(p.confidence),
      asc(sql`COALESCE(${p.lastUsedAt}, ${p.updatedAt})`),
    )
    .limit(procedureOverflowCount);
  for (const row of overflowProcedures) {
    await this.softDeleteProcedure(row.id);
    removedProcedureIds.push(row.id);
  }
  const e = pgSchema.memoryEventsPostgres;
  const staleEvents = await this.db
    .select({ id: e.id })
    .from(e)
    .orderBy(desc(e.id))
    .offset(MEMORY_MAX_EVENTS);
  if (staleEvents.length > 0) {
    await this.db.delete(e).where(
      inArray(
        e.id,
        staleEvents.map((row) => row.id),
      ),
    );
  }
  return { removedItemIds, removedProcedureIds, evictedChunkIds };
}

export async function purgeDeletedBefore(
  this: MemoryStore,
  cutoffIso: string,
): Promise<{
  purgedItems: number;
  purgedProcedures: number;
}> {
  const i = pgSchema.memoryItemsPostgres;
  const itemRows = await this.db
    .select({ id: i.id })
    .from(i)
    .where(
      and(
        eq(i.isDeleted, true),
        isNotNull(i.deletedAt),
        sql`${i.deletedAt} < ${cutoffIso}`,
      ),
    );
  const itemIds = itemRows.map((row) => row.id);
  if (itemIds.length > 0) {
    await this.db
      .delete(pgSchema.memoryUsageEventsPostgres)
      .where(inArray(pgSchema.memoryUsageEventsPostgres.itemId, itemIds));
    await this.db.delete(i).where(inArray(i.id, itemIds));
  }

  const p = pgSchema.memoryProceduresPostgres;
  const procedureRows = await this.db
    .delete(p)
    .where(
      and(
        eq(p.isDeleted, true),
        isNotNull(p.deletedAt),
        sql`${p.deletedAt} < ${cutoffIso}`,
      ),
    )
    .returning({ id: p.id });

  return {
    purgedItems: itemIds.length,
    purgedProcedures: procedureRows.length,
  };
}

export async function recordEvent(
  this: MemoryStore,
  eventType: string,
  entityType: string,
  entityId: string | null,
  payload: unknown,
): Promise<void> {
  await this.db.insert(pgSchema.memoryEventsPostgres).values({
    eventType,
    entityType,
    entityId,
    payloadJson: JSON.stringify(payload),
    createdAt: nowIso(),
  });
}

export async function getLatestEvent(
  this: MemoryStore,
  eventType: string,
  entityId?: string | null,
): Promise<{
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  payload_json: string;
  created_at: string;
} | null> {
  const e = pgSchema.memoryEventsPostgres;
  const rows = await this.db
    .select()
    .from(e)
    .where(
      and(
        eq(e.eventType, eventType),
        entityId === undefined
          ? undefined
          : entityId === null
            ? isNull(e.entityId)
            : eq(e.entityId, entityId),
      ),
    )
    .orderBy(desc(e.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    event_type: row.eventType,
    entity_type: row.entityType,
    entity_id: row.entityId,
    payload_json: row.payloadJson,
    created_at: row.createdAt,
  };
}