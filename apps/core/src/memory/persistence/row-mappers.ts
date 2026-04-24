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
import { parseJsonArray } from './store-utils.js';

type ItemRow = typeof pgSchema.memoryItemsPostgres.$inferSelect;
type ProcedureRow = typeof pgSchema.memoryProceduresPostgres.$inferSelect;
type ChunkRow = typeof pgSchema.memoryChunksPostgres.$inferSelect;

export function toItem(row: ItemRow): MemoryItem {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    group_folder: row.groupFolder,
    user_id: row.userId,
    topic_id: row.topicId,
    kind: row.kind as MemoryItem['kind'],
    key: row.key,
    value: row.value,
    why: row.why ?? undefined,
    load_bearing: row.loadBearing,
    source_turn_id: row.sourceTurnId,
    source: row.source,
    source_folder: row.sourceFolder,
    file_path: row.filePath,
    content_hash: row.contentHash,
    indexed_at: row.indexedAt,
    embedding_pending: row.embeddingPending,
    blocked_reason: row.blockedReason,
    confidence: row.confidence,
    is_pinned: row.isPinned,
    used_count: row.usedCount,
    superseded_by: row.supersededBy,
    is_deleted: row.isDeleted,
    deleted_at: row.deletedAt,
    last_reviewed_at: row.lastReviewedAt,
    version: row.version,
    last_used_at: row.lastUsedAt,
    last_retrieved_at: row.lastRetrievedAt,
    retrieval_count: row.retrievalCount,
    total_score: row.totalScore,
    max_score: row.maxScore,
    query_hashes_json: row.queryHashesJson,
    recall_days_json: row.recallDaysJson,
    embedding_json: row.embeddingJson,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function toProcedure(row: ProcedureRow): MemoryProcedure {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    group_folder: row.groupFolder,
    topic_id: row.topicId,
    title: row.title,
    body: row.body,
    tags: parseJsonArray(row.tagsJson),
    origin:
      row.origin === 'accepted_suggestion' ? 'accepted_suggestion' : 'explicit',
    trigger: row.trigger,
    source: row.source,
    confidence: row.confidence,
    is_deleted: row.isDeleted,
    deleted_at: row.deletedAt,
    version: row.version,
    last_used_at: row.lastUsedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function toChunk(row: ChunkRow): MemoryChunk {
  return {
    id: row.id,
    source_type: row.sourceType,
    source_id: row.sourceId,
    source_path: row.sourcePath,
    scope: row.scope as MemoryScope,
    group_folder: row.groupFolder,
    topic_id: row.topicId,
    kind: row.kind,
    chunk_hash: row.chunkHash,
    text: row.text,
    token_count: row.tokenCount,
    importance_weight: row.importanceWeight,
    embedding_json: row.embeddingJson,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}