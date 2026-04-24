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

export async function saveItem(
  this: MemoryStore,
  input: Pick<
    MemoryItem,
    | 'scope'
    | 'group_folder'
    | 'user_id'
    | 'topic_id'
    | 'kind'
    | 'key'
    | 'value'
    | 'why'
    | 'load_bearing'
    | 'source_turn_id'
    | 'source'
    | 'confidence'
  > & {
    id?: string;
    is_pinned?: boolean;
    used_count?: number;
    version?: number;
    created_at?: string;
    updated_at?: string;
    is_deleted?: boolean;
    deleted_at?: string | null;
    superseded_by?: string | null;
    last_used_at?: string | null;
    last_retrieved_at?: string | null;
    retrieval_count?: number;
    total_score?: number;
    max_score?: number;
    query_hashes_json?: string;
    recall_days_json?: string;
    embedding_json?: string | null;
    last_reviewed_at?: string | null;
    source_folder?: string;
    file_path?: string;
    content_hash?: string;
    indexed_at?: string;
    embedding_pending?: boolean;
    blocked_reason?: string | null;
  },
): Promise<MemoryItem> {
  const now = nowIso();
  const id = input.id || MemoryStore.makeId('mem');
  const embedding = parseEmbedding(input.embedding_json ?? null);
  const values: typeof pgSchema.memoryItemsPostgres.$inferInsert = {
    id,
    scope: input.scope,
    groupFolder: input.group_folder,
    userId: input.user_id ?? null,
    topicId: input.topic_id ?? null,
    kind: input.kind,
    key: input.key,
    value: input.value,
    why: input.why ?? null,
    loadBearing: Boolean(input.load_bearing),
    sourceTurnId: input.source_turn_id ?? null,
    source: input.source,
    sourceFolder: input.source_folder || 'items',
    filePath: input.file_path || '',
    contentHash: input.content_hash || '',
    indexedAt: input.indexed_at ?? input.updated_at ?? now,
    embeddingPending: Boolean(input.embedding_pending),
    blockedReason: input.blocked_reason ?? null,
    confidence: clamp01(Number(input.confidence ?? 0.5)),
    isPinned: Boolean(input.is_pinned),
    usedCount: Math.max(0, Math.round(input.used_count || 0)),
    supersededBy: input.superseded_by ?? null,
    version: Math.max(1, Math.round(input.version || 1)),
    lastUsedAt: input.last_used_at ?? null,
    lastRetrievedAt: input.last_retrieved_at ?? null,
    retrievalCount: Math.max(0, Math.round(input.retrieval_count || 0)),
    totalScore: Number(input.total_score || 0),
    maxScore: Number(input.max_score || 0),
    queryHashesJson: input.query_hashes_json || '[]',
    recallDaysJson: input.recall_days_json || '[]',
    embeddingJson: input.embedding_json ?? null,
    embedding,
    createdAt: input.created_at || now,
    updatedAt: input.updated_at || input.created_at || now,
    isDeleted: Boolean(input.is_deleted),
    deletedAt: input.deleted_at ?? null,
    lastReviewedAt: input.last_reviewed_at ?? null,
  };
  const rows = await this.db
    .insert(pgSchema.memoryItemsPostgres)
    .values(values)
    .onConflictDoUpdate({
      target: pgSchema.memoryItemsPostgres.id,
      set: values,
    })
    .returning();
  return toItem(rows[0]!);
}

export async function patchItem(
  this: MemoryStore,
  id: string,
  expectedVersion: number,
  patch: Partial<
    Pick<
      MemoryItem,
      | 'key'
      | 'value'
      | 'why'
      | 'load_bearing'
      | 'confidence'
      | 'kind'
      | 'source'
      | 'source_turn_id'
      | 'superseded_by'
      | 'last_reviewed_at'
      | 'source_folder'
      | 'file_path'
      | 'content_hash'
      | 'indexed_at'
      | 'embedding_pending'
      | 'blocked_reason'
    >
  >,
): Promise<MemoryItem> {
  const current = await this.getItemById(id);
  if (!current) throw new Error('memory item not found');
  if (current.version !== expectedVersion) {
    throw new Error(
      `${STALE_PATCH_MESSAGE_PREFIX} expected version ${expectedVersion}, current ${current.version}`,
    );
  }
  const setValues: Partial<typeof pgSchema.memoryItemsPostgres.$inferInsert> = {
    updatedAt: nowIso(),
    version: current.version + 1,
  };
  if (patch.key !== undefined) setValues.key = patch.key;
  if (patch.value !== undefined) setValues.value = patch.value;
  if (patch.why !== undefined) setValues.why = patch.why ?? null;
  if (patch.load_bearing !== undefined)
    setValues.loadBearing = Boolean(patch.load_bearing);
  if (patch.confidence !== undefined)
    setValues.confidence = clamp01(Number(patch.confidence));
  if (patch.kind !== undefined) setValues.kind = patch.kind;
  if (patch.source !== undefined) setValues.source = patch.source;
  if (patch.source_turn_id !== undefined)
    setValues.sourceTurnId = patch.source_turn_id ?? null;
  if (patch.superseded_by !== undefined)
    setValues.supersededBy = patch.superseded_by ?? null;
  if (patch.last_reviewed_at !== undefined)
    setValues.lastReviewedAt = patch.last_reviewed_at ?? null;
  if (patch.source_folder !== undefined)
    setValues.sourceFolder = patch.source_folder;
  if (patch.file_path !== undefined) setValues.filePath = patch.file_path;
  if (patch.content_hash !== undefined)
    setValues.contentHash = patch.content_hash;
  if (patch.indexed_at !== undefined) setValues.indexedAt = patch.indexed_at;
  if (patch.embedding_pending !== undefined)
    setValues.embeddingPending = Boolean(patch.embedding_pending);
  if (patch.blocked_reason !== undefined)
    setValues.blockedReason = patch.blocked_reason ?? null;
  const rows = await this.db
    .update(pgSchema.memoryItemsPostgres)
    .set(setValues)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.id, id),
        eq(pgSchema.memoryItemsPostgres.version, expectedVersion),
        eq(pgSchema.memoryItemsPostgres.isDeleted, false),
      ),
    )
    .returning();
  if (!rows[0]) throw new Error('memory item not found');
  return toItem(rows[0]);
}

export async function pinItem(
  this: MemoryStore,
  id: string,
  pinned = true,
): Promise<void> {
  await this.db
    .update(pgSchema.memoryItemsPostgres)
    .set({ isPinned: pinned, updatedAt: nowIso() })
    .where(eq(pgSchema.memoryItemsPostgres.id, id));
}

export async function saveItemEmbedding(
  this: MemoryStore,
  itemId: string,
  embedding: number[],
): Promise<void> {
  if (!Array.isArray(embedding) || embedding.length === 0) return;
  await this.db
    .update(pgSchema.memoryItemsPostgres)
    .set({
      embedding,
      embeddingJson: JSON.stringify(embedding),
      embeddingPending: false,
      blockedReason: null,
      updatedAt: nowIso(),
    })
    .where(eq(pgSchema.memoryItemsPostgres.id, itemId));
}

export async function markItemEmbeddingPending(
  this: MemoryStore,
  itemId: string,
  blockedReason: string | null = null,
): Promise<void> {
  await this.db
    .update(pgSchema.memoryItemsPostgres)
    .set({
      embeddingPending: true,
      ...(blockedReason ? { blockedReason } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(pgSchema.memoryItemsPostgres.id, itemId));
}

export async function setItemFileMetadata(
  this: MemoryStore,
  input: {
    itemId: string;
    source_folder: string;
    file_path: string;
    content_hash: string;
    indexed_at: string;
    embedding_pending?: boolean;
    blocked_reason?: string | null;
  },
): Promise<void> {
  await this.db
    .update(pgSchema.memoryItemsPostgres)
    .set({
      sourceFolder: input.source_folder,
      filePath: input.file_path,
      contentHash: input.content_hash,
      indexedAt: input.indexed_at,
      ...(input.embedding_pending !== undefined
        ? { embeddingPending: input.embedding_pending }
        : {}),
      ...(input.blocked_reason !== undefined
        ? { blockedReason: input.blocked_reason }
        : {}),
      updatedAt: nowIso(),
    })
    .where(eq(pgSchema.memoryItemsPostgres.id, input.itemId));
}

export async function softDeleteItem(
  this: MemoryStore,
  id: string,
  supersededBy?: string | null,
): Promise<void> {
  await this.db
    .update(pgSchema.memoryItemsPostgres)
    .set({
      isDeleted: true,
      deletedAt: nowIso(),
      ...(supersededBy !== undefined ? { supersededBy } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(pgSchema.memoryItemsPostgres.id, id));
}

export async function touchItem(this: MemoryStore, id: string): Promise<void> {
  await this.db
    .update(pgSchema.memoryItemsPostgres)
    .set({ lastUsedAt: nowIso() })
    .where(eq(pgSchema.memoryItemsPostgres.id, id));
}