/* eslint-disable @typescript-eslint/no-unused-vars */
import fs from 'fs';
import path from 'path';

import {
  AGENTS_DIR,
  memoryStorageDir,
  MEMORY_CHUNK_OVERLAP,
  MEMORY_CHUNK_SIZE,
  MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD,
  MEMORY_CONSOLIDATION_MAX_CLUSTERS,
  MEMORY_CONSOLIDATION_MIN_ITEMS,
  MEMORY_DREAMING_CRON,
  MEMORY_DREAMING_CONFIDENCE_BOOST,
  MEMORY_DREAMING_CONFIDENCE_DECAY,
  MEMORY_DREAMING_DECAY_THRESHOLD,
  MEMORY_DREAMING_MIN_RECALLS,
  MEMORY_DREAMING_MIN_UNIQUE_QUERIES,
  MEMORY_DREAMING_PROMOTION_THRESHOLD,
  MEMORY_EXTRACTOR_MIN_CONFIDENCE,
  MEMORY_GLOBAL_KNOWLEDGE_DIR,
  MEMORY_MMR_LAMBDA,
  MEMORY_RETRIEVAL_MIN_SCORE,
  MEMORY_RETENTION_PIN_THRESHOLD,
  MEMORY_RRF_LEXICAL_WEIGHT,
  MEMORY_RRF_VECTOR_WEIGHT,
  MEMORY_RETRIEVAL_LIMIT,
  RUNTIME_MEMORY_ENABLED,
  MEMORY_SEMANTIC_DEDUP_ENABLED,
  MEMORY_SEMANTIC_DEDUP_THRESHOLD,
  MEMORY_SOURCE_TYPE_BOOSTS,
  MEMORY_SCOPE_POLICY,
  MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS,
  RUNTIME_MEMORY_DREAMING_ENABLED,
} from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  consolidateMemoryItems,
  type ConsolidationResult,
} from './memory-consolidation.js';
import {
  type DreamingResult,
  runDreamingSweep as runMemoryDreamingSweep,
} from './memory-dreaming.js';
import type { MemoryExtractorUsage } from './extractor-types.js';
import type { ChunkInsert } from './persistence/store.js';
import type { JournalAppendInput } from './memory-journal.js';
import { MemoryRootService } from './memory-root.js';
import { fuseSearchResults, mergeSearchResults } from './memory-retrieval.js';
import { classifySensitiveMemoryMaterial } from './sensitive-material.js';
import {
  MEMORY_GLOBAL_GROUP_FOLDER,
  type MemoryItem,
  type MemoryProcedure,
  type MemoryScope,
  type MemorySearchResult,
  type MemoryWriteContext,
  normalizeMemoryTopicId,
  type PatchMemoryInput,
  type PatchProcedureInput,
  type SaveMemoryInput,
  type SaveProcedureInput,
} from './memory-types.js';
import { MemoryService } from './memory-service.js';
import {
  chunkText,
  clampConfidence,
  dedupeItemsById,
  directorySizeKb,
  fingerprintSensitiveToken,
  isStalePatchError,
  normalizeSingleLine,
  parseTranscriptArc,
  truncate,
} from './memory-service-utils.js';
import type {
  ArcTurn,
  BuildBriefInput,
  MemoryStatusSnapshot,
  SearchInput,
  SourceDoc,
  TranscriptExtractionInput,
} from './memory-service-types.js';

export async function saveMemory(
  this: MemoryService,
  input: SaveMemoryInput,
  ctx: MemoryWriteContext,
  precomputedEmbedding?: number[] | null,
): Promise<MemoryItem> {
  if (!RUNTIME_MEMORY_ENABLED) {
    throw new Error('memory is disabled');
  }
  const resolvedScope = this.resolveScope(input.scope, ctx);
  const scope =
    resolvedScope === 'user' && !input.user_id ? 'group' : resolvedScope;
  this.enforceScope(scope, ctx);
  const groupFolder = this.resolveTargetGroupFolder(input.group_folder, ctx);
  const confidence = clampConfidence(input.confidence);
  const kind = input.kind || 'fact';
  const source = input.source || 'agent';
  const topicId =
    scope === 'user'
      ? undefined
      : normalizeMemoryTopicId(input.topic_id || ctx.threadId);
  const actor = this.resolveWriteActor(ctx, source);
  await this.assertNoSensitiveMaterialOrThrow({
    groupFolder,
    actor,
    scope,
    fields: [
      { name: 'key', value: input.key },
      { name: 'value', value: input.value },
      { name: 'why', value: input.why },
    ],
  });

  const existing = await this.store.findItemByKey({
    scope,
    groupFolder,
    key: input.key,
    userId: input.user_id || null,
    topicId: topicId || null,
  });

  let embedding =
    precomputedEmbedding === undefined ? null : precomputedEmbedding;
  if (embedding === null && MEMORY_SEMANTIC_DEDUP_ENABLED) {
    embedding = await this.embeddings.embedOne(`${input.key}: ${input.value}`);
  }

  if (existing) {
    const patch = {
      key: input.key,
      value: input.value,
      why: input.why,
      load_bearing: input.load_bearing,
      source_turn_id: input.source_turn_id,
      kind,
      source,
      confidence,
    };
    const { memory, previousVersion } = await this.patchItemWithRetry({
      initialItem: existing,
      reloadItem: () =>
        this.store.findItemByKey({
          scope,
          groupFolder,
          key: input.key,
          userId: input.user_id || null,
          topicId: topicId || null,
        }),
      patch,
    });
    const pinnedChanged = await this.pinIfNeeded(memory);
    if (embedding) {
      await this.persistEmbeddingBestEffort(memory, embedding, actor);
    }

    await this.store.recordEvent('memory_saved', 'memory_item', memory.id, {
      scope: memory.scope,
      group_folder: memory.group_folder,
      key: memory.key,
      confidence: memory.confidence,
      deduped: 'key',
    });
    this.appendJournal({
      kind: 'memory.item.patched',
      group_folder: memory.group_folder,
      scope: memory.scope,
      actor,
      payload: {
        ...memory,
        prev_version: previousVersion,
      },
    });
    if (pinnedChanged) {
      this.appendJournal({
        kind: 'memory.item.pinned',
        group_folder: memory.group_folder,
        scope: memory.scope,
        actor,
        payload: {
          id: memory.id,
          pinned: true,
        },
      });
    }

    return memory;
  }

  if (MEMORY_SEMANTIC_DEDUP_ENABLED && embedding) {
    const similar = await this.store.findSimilarItems({
      scope,
      groupFolder,
      userId: input.user_id || null,
      topicId: topicId || null,
      embedding,
      limit: 3,
    });
    const best = similar[0];
    if (best && best.similarity >= MEMORY_SEMANTIC_DEDUP_THRESHOLD) {
      const patch = {
        key: input.key,
        value: input.value,
        why: input.why,
        load_bearing: input.load_bearing,
        source_turn_id: input.source_turn_id,
        kind,
        source,
        confidence,
      };
      const { memory, previousVersion } = await this.patchItemWithRetry({
        initialItem: best.item,
        reloadItem: () => this.store.getItemById(best.item.id),
        patch,
      });
      const pinnedChanged = await this.pinIfNeeded(memory);
      await this.persistEmbeddingBestEffort(memory, embedding, actor);
      await this.store.recordEvent('memory_saved', 'memory_item', memory.id, {
        scope: memory.scope,
        group_folder: memory.group_folder,
        key: memory.key,
        confidence: memory.confidence,
        deduped: 'semantic',
        similarity: best.similarity,
      });
      this.appendJournal({
        kind: 'memory.item.patched',
        group_folder: memory.group_folder,
        scope: memory.scope,
        actor,
        payload: {
          ...memory,
          prev_version: previousVersion,
        },
      });
      if (pinnedChanged) {
        this.appendJournal({
          kind: 'memory.item.pinned',
          group_folder: memory.group_folder,
          scope: memory.scope,
          actor,
          payload: {
            id: memory.id,
            pinned: true,
          },
        });
      }
      return memory;
    }
  }

  const memory = await this.store.saveItem({
    scope,
    group_folder: groupFolder,
    user_id: input.user_id || null,
    topic_id: topicId || null,
    kind,
    key: input.key,
    value: input.value,
    why: input.why,
    load_bearing: input.load_bearing,
    source_turn_id: input.source_turn_id,
    source,
    confidence,
    is_pinned: confidence >= MEMORY_RETENTION_PIN_THRESHOLD,
  });
  const pinnedChanged = await this.pinIfNeeded(memory);
  if (embedding) {
    await this.persistEmbeddingBestEffort(memory, embedding, actor);
  }

  await this.store.recordEvent('memory_saved', 'memory_item', memory.id, {
    scope: memory.scope,
    group_folder: memory.group_folder,
    key: memory.key,
    confidence: memory.confidence,
    deduped: 'none',
  });
  this.appendJournal({
    kind: 'memory.item.saved',
    group_folder: memory.group_folder,
    scope: memory.scope,
    actor,
    payload: memory,
  });
  if (pinnedChanged) {
    this.appendJournal({
      kind: 'memory.item.pinned',
      group_folder: memory.group_folder,
      scope: memory.scope,
      actor,
      payload: {
        id: memory.id,
        pinned: true,
      },
    });
  }

  return memory;
}

export async function patchMemory(
  this: MemoryService,
  input: PatchMemoryInput,
  ctx: MemoryWriteContext,
): Promise<MemoryItem> {
  if (!RUNTIME_MEMORY_ENABLED) {
    throw new Error('memory is disabled');
  }
  const existing = await this.store.getItemById(input.id);
  if (!existing) throw new Error('memory item not found');
  this.enforcePatchAccess(existing.scope, existing.group_folder, ctx);
  const actor = this.resolveWriteActor(ctx, existing.source);
  await this.assertNoSensitiveMaterialOrThrow({
    groupFolder: existing.group_folder,
    actor,
    scope: existing.scope,
    fields: [
      { name: 'key', value: input.key },
      { name: 'value', value: input.value },
      { name: 'why', value: input.why },
    ],
  });

  const patched = await this.store.patchItem(input.id, input.expected_version, {
    key: input.key,
    value: input.value,
    why: input.why,
    load_bearing: input.load_bearing,
    confidence: input.confidence,
  });
  const pinnedChanged = await this.pinIfNeeded(patched);

  await this.store.recordEvent('memory_patched', 'memory_item', patched.id, {
    version: patched.version,
    confidence: patched.confidence,
  });
  this.appendJournal({
    kind: 'memory.item.patched',
    group_folder: patched.group_folder,
    scope: patched.scope,
    actor,
    payload: {
      ...patched,
      prev_version: existing.version,
    },
  });
  if (pinnedChanged) {
    this.appendJournal({
      kind: 'memory.item.pinned',
      group_folder: patched.group_folder,
      scope: patched.scope,
      actor,
      payload: {
        id: patched.id,
        pinned: true,
      },
    });
  }

  return patched;
}