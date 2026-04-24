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

export async function incrementRetrievalCount(
  this: MemoryStore,
  ids: string[],
): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return;
  await Promise.all(unique.map((id) => this.recordRetrievalSignal(id, 0, '')));
}

export async function recordRetrievalSignal(
  this: MemoryStore,
  itemId: string,
  score: number,
  queryHash: string,
): Promise<void> {
  const current = await this.getItemById(itemId);
  if (!current) return;
  const safeScore = Number.isFinite(score) && score > 0 ? score : 0;
  const queryHashes = parseJsonArray(current.query_hashes_json);
  if (queryHash) queryHashes.push(queryHash);
  const recallDays = parseJsonArray(current.recall_days_json);
  recallDays.push(nowIso().slice(0, 10));
  await this.db
    .update(pgSchema.memoryItemsPostgres)
    .set({
      retrievalCount: current.retrieval_count + 1,
      lastRetrievedAt: nowIso(),
      totalScore: current.total_score + safeScore,
      maxScore: Math.max(current.max_score, safeScore),
      queryHashesJson: JSON.stringify([...new Set(queryHashes)].slice(-50)),
      recallDaysJson: JSON.stringify([...new Set(recallDays)].slice(-90)),
    })
    .where(eq(pgSchema.memoryItemsPostgres.id, itemId));
}

export async function bumpConfidence(
  this: MemoryStore,
  ids: string[],
  delta: number,
): Promise<void> {
  if (delta > 0) await this.adjustConfidence(ids, delta);
}

export async function adjustConfidence(
  this: MemoryStore,
  ids: string[],
  delta: number,
): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return;
  const rows = await this.db
    .select({
      id: pgSchema.memoryItemsPostgres.id,
      confidence: pgSchema.memoryItemsPostgres.confidence,
    })
    .from(pgSchema.memoryItemsPostgres)
    .where(inArray(pgSchema.memoryItemsPostgres.id, unique));
  await Promise.all(
    rows.map((row) =>
      this.db
        .update(pgSchema.memoryItemsPostgres)
        .set({
          confidence: clamp01(row.confidence + delta),
          updatedAt: nowIso(),
        })
        .where(eq(pgSchema.memoryItemsPostgres.id, row.id)),
    ),
  );
}

export async function decayUnusedConfidence(
  this: MemoryStore,
  groupFolder: string,
  delta: number,
): Promise<number> {
  if (delta <= 0) return 0;
  const i = pgSchema.memoryItemsPostgres;
  const rows = await this.db
    .select({ id: i.id, confidence: i.confidence })
    .from(i)
    .where(
      and(
        eq(i.isDeleted, false),
        eq(i.isPinned, false),
        eq(i.retrievalCount, 0),
        or(eq(i.scope, 'global'), eq(i.groupFolder, groupFolder)),
      ),
    );
  await Promise.all(
    rows.map((row) =>
      this.db
        .update(i)
        .set({
          confidence: clamp01(row.confidence - delta),
          updatedAt: nowIso(),
        })
        .where(eq(i.id, row.id)),
    ),
  );
  return rows.length;
}

export async function countReflectionsSinceLastUsageDecay(
  this: MemoryStore,
  groupFolder: string,
): Promise<number> {
  const e = pgSchema.memoryEventsPostgres;
  const lastDecay = (
    await this.db
      .select({ id: e.id })
      .from(e)
      .where(
        and(eq(e.eventType, 'usage_decay_run'), eq(e.entityId, groupFolder)),
      )
      .orderBy(desc(e.id))
      .limit(1)
  )[0]?.id;
  const rows = await this.db
    .select({ id: e.id })
    .from(e)
    .where(
      and(
        eq(e.eventType, 'reflection_completed'),
        eq(e.entityId, groupFolder),
        lastDecay ? gt(e.id, lastDecay) : undefined,
      ),
    );
  return rows.length;
}

export async function recordUsageDecayRun(
  this: MemoryStore,
  groupFolder: string,
): Promise<void> {
  await this.recordEvent('usage_decay_run', 'memory_usage', groupFolder, {
    group_folder: groupFolder,
    created_at: nowIso(),
  });
}

export async function listTopItems(
  this: MemoryStore,
  scope: MemoryScope,
  groupFolder: string,
  limit: number,
  userId?: string,
  topicId?: string,
): Promise<MemoryItem[]> {
  const i = pgSchema.memoryItemsPostgres;
  const rows = await this.db
    .select()
    .from(i)
    .where(
      and(
        eq(i.isDeleted, false),
        eq(i.scope, scope),
        scope === 'global' ? undefined : eq(i.groupFolder, groupFolder),
        scope === 'user'
          ? userId
            ? eq(i.userId, userId)
            : sql`false`
          : eq(sql`COALESCE(${i.topicId}, '')`, topicId || ''),
      ),
    )
    .orderBy(
      desc(i.confidence),
      desc(sql`COALESCE(${i.lastUsedAt}, ${i.updatedAt})`),
    )
    .limit(Math.max(1, limit));
  return rows.map((row) => toItem(row));
}