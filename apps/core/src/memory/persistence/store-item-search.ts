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

export async function findSimilarItems(
  this: MemoryStore,
  input: {
    scope: MemoryScope;
    groupFolder: string;
    userId?: string | null;
    topicId?: string | null;
    embedding: number[];
    limit?: number;
  },
): Promise<SimilarMemoryItemMatch[]> {
  const i = pgSchema.memoryItemsPostgres;
  const distance = cosineDistance(i.embedding, input.embedding);
  const rows = await this.db
    .select({
      row: i,
      distance,
    })
    .from(i)
    .where(
      and(
        eq(i.isDeleted, false),
        eq(i.scope, input.scope),
        isNotNull(i.embedding),
        input.scope === 'global'
          ? undefined
          : eq(i.groupFolder, input.groupFolder),
        input.scope === 'user'
          ? input.userId
            ? eq(i.userId, input.userId)
            : sql`false`
          : eq(sql`COALESCE(${i.topicId}, '')`, input.topicId || ''),
      ),
    )
    .orderBy(distance)
    .limit(Math.max(1, input.limit ?? 5));
  return rows.map((row) => ({
    item: toItem(row.row),
    similarity: clamp01(1 - Number(row.distance || 1)),
  }));
}

export async function listActiveItems(
  this: MemoryStore,
  groupFolder: string,
  limit = 5000,
): Promise<MemoryItem[]> {
  const rows = await this.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.isDeleted, false),
        eq(pgSchema.memoryItemsPostgres.groupFolder, groupFolder),
        sql`${pgSchema.memoryItemsPostgres.scope} <> 'global'`,
      ),
    )
    .orderBy(
      desc(pgSchema.memoryItemsPostgres.confidence),
      desc(pgSchema.memoryItemsPostgres.updatedAt),
    )
    .limit(Math.max(1, limit));
  return rows.map((row) => toItem(row));
}

export async function searchItemsByText(
  this: MemoryStore,
  query: string,
  groupFolder: string,
  limit: number,
  userId?: string,
  topicId?: string,
): Promise<MemorySearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const i = pgSchema.memoryItemsPostgres;
  const document = sql`to_tsvector('english', ${i.key} || ' ' || ${i.value} || ' ' || COALESCE(${i.why}, ''))`;
  const searchQuery = sql`plainto_tsquery('english', ${trimmed})`;
  const score = sql<number>`ts_rank_cd(${document}, ${searchQuery})`;
  const rows = await this.db
    .select({
      id: i.id,
      key: i.key,
      value: i.value,
      why: i.why,
      scope: i.scope,
      groupFolder: i.groupFolder,
      createdAt: i.createdAt,
      score,
    })
    .from(i)
    .where(
      and(
        eq(i.isDeleted, false),
        or(eq(i.scope, 'global'), eq(i.groupFolder, groupFolder)),
        sql`${document} @@ ${searchQuery}`,
        userId
          ? or(sql`${i.scope} <> 'user'`, eq(i.userId, userId))
          : sql`${i.scope} <> 'user'`,
        eq(sql`COALESCE(${i.topicId}, '')`, topicId || ''),
      ),
    )
    .orderBy(desc(score), desc(i.confidence), desc(i.updatedAt))
    .limit(Math.max(1, limit));
  return rows.map((row) => {
    const text = [row.key, row.value, row.why].filter(Boolean).join(': ');
    return {
      id: row.id,
      source_type: 'memory_item',
      source_path: '',
      text,
      scope: row.scope as MemoryScope,
      group_folder: row.groupFolder,
      created_at: row.createdAt,
      lexical_score: Number(row.score || 0),
      vector_score: 0,
      fused_score: Number(row.score || 0),
    };
  });
}