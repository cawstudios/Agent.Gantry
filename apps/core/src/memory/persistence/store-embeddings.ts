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

export async function getCachedEmbedding(
  this: MemoryStore,
  textHash: string,
  model: string,
): Promise<number[] | null> {
  const rows = await this.db
    .select()
    .from(pgSchema.embeddingCachePostgres)
    .where(
      and(
        eq(pgSchema.embeddingCachePostgres.textHash, textHash),
        eq(pgSchema.embeddingCachePostgres.model, model),
      ),
    )
    .limit(1);
  return rows[0] ? parseEmbedding(rows[0].embeddingJson) : null;
}

export async function putCachedEmbedding(
  this: MemoryStore,
  textHash: string,
  model: string,
  embedding: number[],
): Promise<void> {
  if (!Array.isArray(embedding) || embedding.length === 0) return;
  await this.db
    .insert(pgSchema.embeddingCachePostgres)
    .values({
      textHash,
      model,
      embeddingJson: JSON.stringify(embedding),
      embedding,
      createdAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [
        pgSchema.embeddingCachePostgres.textHash,
        pgSchema.embeddingCachePostgres.model,
      ],
      set: {
        embeddingJson: JSON.stringify(embedding),
        embedding,
        createdAt: nowIso(),
      },
    });
}