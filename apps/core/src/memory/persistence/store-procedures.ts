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

export async function saveProcedure(
  this: MemoryStore,
  input: Omit<
    MemoryProcedure,
    | 'id'
    | 'version'
    | 'created_at'
    | 'updated_at'
    | 'last_used_at'
    | 'is_deleted'
    | 'deleted_at'
  > & {
    id?: string;
    version?: number;
    created_at?: string;
    updated_at?: string;
    last_used_at?: string | null;
    is_deleted?: boolean;
    deleted_at?: string | null;
  },
): Promise<MemoryProcedure> {
  const now = nowIso();
  const values: typeof pgSchema.memoryProceduresPostgres.$inferInsert = {
    id: input.id || MemoryStore.makeId('proc'),
    scope: input.scope,
    groupFolder: input.group_folder,
    topicId: input.topic_id ?? null,
    title: input.title,
    body: input.body,
    tagsJson: JSON.stringify(input.tags),
    origin: input.origin || 'explicit',
    trigger: input.trigger || null,
    source: input.source,
    confidence: clamp01(input.confidence),
    version: Math.max(1, Math.round(input.version || 1)),
    lastUsedAt: input.last_used_at ?? null,
    createdAt: input.created_at || now,
    updatedAt: input.updated_at || input.created_at || now,
    isDeleted: Boolean(input.is_deleted),
    deletedAt: input.deleted_at ?? null,
  };
  const rows = await this.db
    .insert(pgSchema.memoryProceduresPostgres)
    .values(values)
    .onConflictDoUpdate({
      target: pgSchema.memoryProceduresPostgres.id,
      set: values,
    })
    .returning();
  return toProcedure(rows[0]!);
}

export async function getProcedureById(
  this: MemoryStore,
  id: string,
): Promise<MemoryProcedure | null> {
  const rows = await this.db
    .select()
    .from(pgSchema.memoryProceduresPostgres)
    .where(
      and(
        eq(pgSchema.memoryProceduresPostgres.id, id),
        eq(pgSchema.memoryProceduresPostgres.isDeleted, false),
      ),
    )
    .limit(1);
  return rows[0] ? toProcedure(rows[0]) : null;
}

export async function getProcedureByIdAny(
  this: MemoryStore,
  id: string,
): Promise<MemoryProcedure | null> {
  const rows = await this.db
    .select()
    .from(pgSchema.memoryProceduresPostgres)
    .where(eq(pgSchema.memoryProceduresPostgres.id, id))
    .limit(1);
  return rows[0] ? toProcedure(rows[0]) : null;
}

export async function patchProcedure(
  this: MemoryStore,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<MemoryProcedure, 'title' | 'body' | 'tags' | 'trigger' | 'confidence'>
  >,
): Promise<MemoryProcedure> {
  const current = await this.getProcedureById(id);
  if (!current) throw new Error('memory procedure not found');
  if (current.version !== expectedVersion) {
    throw new Error(
      `${STALE_PATCH_MESSAGE_PREFIX} expected version ${expectedVersion}, current ${current.version}`,
    );
  }
  const setValues: Partial<
    typeof pgSchema.memoryProceduresPostgres.$inferInsert
  > = {
    version: current.version + 1,
    updatedAt: nowIso(),
  };
  if (patch.title !== undefined) setValues.title = patch.title;
  if (patch.body !== undefined) setValues.body = patch.body;
  if (patch.tags !== undefined) setValues.tagsJson = JSON.stringify(patch.tags);
  if (patch.trigger !== undefined) setValues.trigger = patch.trigger;
  if (patch.confidence !== undefined)
    setValues.confidence = clamp01(patch.confidence);
  const rows = await this.db
    .update(pgSchema.memoryProceduresPostgres)
    .set(setValues)
    .where(
      and(
        eq(pgSchema.memoryProceduresPostgres.id, id),
        eq(pgSchema.memoryProceduresPostgres.version, expectedVersion),
        eq(pgSchema.memoryProceduresPostgres.isDeleted, false),
      ),
    )
    .returning();
  if (!rows[0]) throw new Error('memory procedure not found');
  return toProcedure(rows[0]);
}

export async function listTopProcedures(
  this: MemoryStore,
  groupFolder: string,
  limit: number,
  topicId?: string,
): Promise<MemoryProcedure[]> {
  const p = pgSchema.memoryProceduresPostgres;
  const rows = await this.db
    .select()
    .from(p)
    .where(
      and(
        eq(p.isDeleted, false),
        or(
          eq(p.scope, 'global'),
          and(eq(p.scope, 'group'), eq(p.groupFolder, groupFolder)),
        ),
        eq(sql`COALESCE(${p.topicId}, '')`, topicId || ''),
      ),
    )
    .orderBy(
      desc(p.confidence),
      desc(sql`COALESCE(${p.lastUsedAt}, ${p.updatedAt})`),
    )
    .limit(Math.max(1, limit));
  return rows.map((row) => toProcedure(row));
}

export async function softDeleteProcedure(
  this: MemoryStore,
  id: string,
): Promise<void> {
  await this.db
    .update(pgSchema.memoryProceduresPostgres)
    .set({ isDeleted: true, deletedAt: nowIso(), updatedAt: nowIso() })
    .where(eq(pgSchema.memoryProceduresPostgres.id, id));
}

export async function searchProceduresByText(
  this: MemoryStore,
  query: string,
  groupFolder: string,
  limit: number,
): Promise<MemoryProcedure[]> {
  const p = pgSchema.memoryProceduresPostgres;
  const rows = await this.db
    .select()
    .from(p)
    .where(
      and(
        eq(p.isDeleted, false),
        or(
          eq(p.scope, 'global'),
          and(eq(p.scope, 'group'), eq(p.groupFolder, groupFolder)),
        ),
        or(
          ilike(p.title, likePattern(query)),
          ilike(p.body, likePattern(query)),
        ),
      ),
    )
    .orderBy(desc(p.confidence), desc(p.updatedAt))
    .limit(Math.max(1, limit));
  return rows.map((row) => toProcedure(row));
}