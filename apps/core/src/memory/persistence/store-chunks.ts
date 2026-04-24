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

export async function listIndexedChunkFiles(this: MemoryStore): Promise<
  Array<{
    source_type: string;
    source_id: string;
    source_path: string;
    indexed_at: string | null;
  }>
> {
  const c = pgSchema.memoryChunksPostgres;
  const rows = await this.db
    .select({
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      sourcePath: c.sourcePath,
      indexedAt: sql<string | null>`MAX(${c.updatedAt})`,
    })
    .from(c)
    .where(sql`${c.sourcePath} <> ''`)
    .groupBy(c.sourceType, c.sourceId, c.sourcePath);
  return rows.map((row) => ({
    source_type: row.sourceType,
    source_id: row.sourceId,
    source_path: row.sourcePath,
    indexed_at: row.indexedAt,
  }));
}

export async function chunkExists(
  this: MemoryStore,
  input: ChunkInsert,
): Promise<boolean> {
  const rows = await this.db
    .select({ id: pgSchema.memoryChunksPostgres.id })
    .from(pgSchema.memoryChunksPostgres)
    .where(
      eq(pgSchema.memoryChunksPostgres.chunkHash, MemoryStore.chunkHash(input)),
    )
    .limit(1);
  return rows.length > 0;
}

export async function saveChunks(
  this: MemoryStore,
  chunks: ChunkInsert[],
): Promise<number> {
  let inserted = 0;
  for (const chunk of chunks) {
    const now = nowIso();
    const embeddingJson = chunk.embedding
      ? JSON.stringify(chunk.embedding)
      : null;
    const rows = await this.db
      .insert(pgSchema.memoryChunksPostgres)
      .values({
        id: MemoryStore.makeId('chunk'),
        sourceType: chunk.source_type,
        sourceId: chunk.source_id,
        sourcePath: chunk.source_path,
        scope: chunk.scope,
        groupFolder: chunk.group_folder,
        topicId: chunk.topic_id ?? null,
        kind: chunk.kind,
        chunkHash: MemoryStore.chunkHash(chunk),
        text: chunk.text,
        tokenCount: Math.max(1, Math.ceil(chunk.text.length / 4)),
        importanceWeight: Math.max(0, chunk.importance_weight ?? 1),
        embeddingJson,
        embedding: chunk.embedding,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: pgSchema.memoryChunksPostgres.id });
    if (rows.length > 0) inserted += 1;
  }
  return inserted;
}

export async function lexicalSearch(
  this: MemoryStore,
  query: string,
  groupFolder: string,
  limit: number,
  topicId?: string,
): Promise<MemorySearchResult[]> {
  const c = pgSchema.memoryChunksPostgres;
  const score = sql<number>`ts_rank_cd(to_tsvector('english', ${c.text}), plainto_tsquery('english', ${query}))`;
  const rows = await this.db
    .select({
      id: c.id,
      sourceType: c.sourceType,
      sourcePath: c.sourcePath,
      text: c.text,
      scope: c.scope,
      groupFolder: c.groupFolder,
      createdAt: c.createdAt,
      score,
    })
    .from(c)
    .where(
      and(
        sql`to_tsvector('english', ${c.text}) @@ plainto_tsquery('english', ${query})`,
        or(eq(c.scope, 'global'), eq(c.groupFolder, groupFolder)),
        eq(sql`COALESCE(${c.topicId}, '')`, topicId || ''),
      ),
    )
    .orderBy(desc(score))
    .limit(Math.max(1, limit));
  return rows.map((row) => ({
    id: row.id,
    source_type: row.sourceType,
    source_path: row.sourcePath,
    text: row.text,
    scope: row.scope as MemoryScope,
    group_folder: row.groupFolder,
    created_at: row.createdAt,
    lexical_score: Number(row.score || 0),
    vector_score: 0,
    fused_score: 0,
  }));
}

export async function vectorSearch(
  this: MemoryStore,
  queryEmbedding: number[],
  groupFolder: string,
  limit: number,
  topicId?: string,
): Promise<MemorySearchResult[]> {
  const c = pgSchema.memoryChunksPostgres;
  const distance = cosineDistance(c.embedding, queryEmbedding);
  const rows = await this.db
    .select({
      id: c.id,
      sourceType: c.sourceType,
      sourcePath: c.sourcePath,
      text: c.text,
      scope: c.scope,
      groupFolder: c.groupFolder,
      createdAt: c.createdAt,
      distance,
    })
    .from(c)
    .where(
      and(
        isNotNull(c.embedding),
        or(eq(c.scope, 'global'), eq(c.groupFolder, groupFolder)),
        eq(sql`COALESCE(${c.topicId}, '')`, topicId || ''),
      ),
    )
    .orderBy(distance)
    .limit(Math.max(1, limit));
  return rows.map((row) => ({
    id: row.id,
    source_type: row.sourceType,
    source_path: row.sourcePath,
    text: row.text,
    scope: row.scope as MemoryScope,
    group_folder: row.groupFolder,
    created_at: row.createdAt,
    lexical_score: 0,
    vector_score: clamp01(1 - Number(row.distance || 1)),
    fused_score: 0,
  }));
}

export async function listSourceChunks(
  this: MemoryStore,
  sourceType: string,
  sourceId: string,
): Promise<MemoryChunk[]> {
  const rows = await this.db
    .select()
    .from(pgSchema.memoryChunksPostgres)
    .where(
      and(
        eq(pgSchema.memoryChunksPostgres.sourceType, sourceType),
        eq(pgSchema.memoryChunksPostgres.sourceId, sourceId),
      ),
    );
  return rows.map((row) => toChunk(row));
}

export async function deleteSourceChunks(
  this: MemoryStore,
  sourceType: string,
  sourceId: string,
): Promise<number> {
  const rows = await this.db
    .delete(pgSchema.memoryChunksPostgres)
    .where(
      and(
        eq(pgSchema.memoryChunksPostgres.sourceType, sourceType),
        eq(pgSchema.memoryChunksPostgres.sourceId, sourceId),
      ),
    )
    .returning({ id: pgSchema.memoryChunksPostgres.id });
  return rows.length;
}