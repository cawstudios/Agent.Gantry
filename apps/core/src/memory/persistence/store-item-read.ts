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

export async function findItemByKey(
  this: MemoryStore,
  input: {
    scope: MemoryScope;
    groupFolder: string;
    key: string;
    userId?: string | null;
    topicId?: string | null;
  },
): Promise<MemoryItem | null> {
  const i = pgSchema.memoryItemsPostgres;
  const rows = await this.db
    .select()
    .from(i)
    .where(
      and(
        eq(i.isDeleted, false),
        eq(i.scope, input.scope),
        eq(i.key, input.key),
        input.scope === 'global'
          ? eq(sql`COALESCE(${i.topicId}, '')`, input.topicId || '')
          : eq(i.groupFolder, input.groupFolder),
        input.scope === 'user'
          ? input.userId
            ? eq(i.userId, input.userId)
            : sql`false`
          : undefined,
        input.scope !== 'user'
          ? eq(sql`COALESCE(${i.topicId}, '')`, input.topicId || '')
          : undefined,
      ),
    )
    .orderBy(desc(i.updatedAt))
    .limit(1);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function getItemById(
  this: MemoryStore,
  id: string,
): Promise<MemoryItem | null> {
  const rows = await this.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.id, id),
        eq(pgSchema.memoryItemsPostgres.isDeleted, false),
      ),
    )
    .limit(1);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function getItemByIdAny(
  this: MemoryStore,
  id: string,
): Promise<MemoryItem | null> {
  const rows = await this.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(eq(pgSchema.memoryItemsPostgres.id, id))
    .limit(1);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function getItemByFilePath(
  this: MemoryStore,
  filePath: string,
): Promise<MemoryItem | null> {
  const rows = await this.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.isDeleted, false),
        eq(pgSchema.memoryItemsPostgres.filePath, filePath),
      ),
    )
    .orderBy(desc(pgSchema.memoryItemsPostgres.updatedAt))
    .limit(1);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function getItemByFilePathAny(
  this: MemoryStore,
  filePath: string,
): Promise<MemoryItem | null> {
  const rows = await this.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(eq(pgSchema.memoryItemsPostgres.filePath, filePath))
    .orderBy(desc(pgSchema.memoryItemsPostgres.updatedAt))
    .limit(1);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function listIndexedFiles(this: MemoryStore): Promise<
  Array<{
    id: string;
    file_path: string;
    content_hash: string;
    indexed_at: string | null;
    source_folder: string;
  }>
> {
  const i = pgSchema.memoryItemsPostgres;
  const rows = await this.db
    .select({
      id: i.id,
      filePath: i.filePath,
      contentHash: i.contentHash,
      indexedAt: i.indexedAt,
      sourceFolder: i.sourceFolder,
    })
    .from(i)
    .where(and(eq(i.isDeleted, false), sql`${i.filePath} <> ''`));
  return rows.map((row) => ({
    id: row.id,
    file_path: row.filePath,
    content_hash: row.contentHash,
    indexed_at: row.indexedAt,
    source_folder: row.sourceFolder,
  }));
}