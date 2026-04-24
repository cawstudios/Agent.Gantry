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

export async function pinIfNeeded(
  this: MemoryService,
  memory: MemoryItem,
): Promise<boolean> {
  if (memory.is_pinned) return false;
  if (memory.confidence < MEMORY_RETENTION_PIN_THRESHOLD) return false;
  await this.store.pinItem(memory.id, true);
  memory.is_pinned = true;
  return true;
}

export function resolveScope(
  this: MemoryService,
  scope: MemoryScope | undefined,
  ctx: MemoryWriteContext,
): MemoryScope {
  if (scope) return scope;
  if (MEMORY_SCOPE_POLICY === 'global') {
    return ctx.isMain ? 'global' : 'group';
  }
  return 'group';
}

export function enforceScope(
  this: MemoryService,
  scope: MemoryScope,
  ctx: MemoryWriteContext,
): void {
  if (scope === 'global' && !ctx.isMain) {
    throw new Error(
      'global memory writes are allowed only from main/admin context',
    );
  }
}

export function enforcePatchAccess(
  this: MemoryService,
  scope: MemoryScope,
  groupFolder: string,
  ctx: MemoryWriteContext,
): void {
  if (ctx.isMain) return;
  if (scope === 'global') {
    throw new Error(
      'global memory writes are allowed only from main/admin context',
    );
  }
  if (groupFolder !== ctx.groupFolder) {
    throw new Error('memory writes are limited to the caller group');
  }
}

export function resolveTargetGroupFolder(
  this: MemoryService,
  requestedGroupFolder: string | undefined,
  ctx: MemoryWriteContext,
): string {
  if (ctx.isMain && requestedGroupFolder) {
    return requestedGroupFolder;
  }
  return ctx.groupFolder;
}

export function resolveWriteActor(
  this: MemoryService,
  ctx: MemoryWriteContext,
  source?: string,
): string {
  const explicit = ctx.actor?.trim();
  if (explicit) return explicit;
  const normalized = source?.trim().toLowerCase();
  if (normalized === 'precompact' || normalized === 'session-end') {
    return `extractor:${normalized}`;
  }
  if (normalized === 'consolidation') {
    return 'consolidation';
  }
  if (normalized === 'dreaming') {
    return 'dreaming';
  }
  if (normalized === 'mcp-tool') {
    return 'mcp-tool';
  }
  return 'agent';
}

export async function patchItemWithRetry(
  this: MemoryService,
  input: {
    initialItem: MemoryItem;
    reloadItem: () => Promise<MemoryItem | null>;
    patch: {
      key: string;
      value: string;
      why?: string;
      load_bearing?: boolean;
      source_turn_id?: string;
      kind: MemoryItem['kind'];
      source: string;
      confidence: number;
    };
  },
): Promise<{ memory: MemoryItem; previousVersion: number }> {
  let current = input.initialItem;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const memory = await this.store.patchItem(current.id, current.version, {
        ...input.patch,
      });
      return {
        memory,
        previousVersion: current.version,
      };
    } catch (err) {
      if (!isStalePatchError(err) || attempt > 0) {
        throw err;
      }
      MemoryService.incrementCounter('stale_patch_retries_total');
      const refreshed = await input.reloadItem();
      if (!refreshed) {
        throw err;
      }
      current = refreshed;
    }
  }
  throw new Error('patch retry failed');
}

export async function assertNoSensitiveMaterialOrThrow(
  this: MemoryService,
  input: {
    groupFolder: string;
    actor: string;
    scope: MemoryScope;
    fields: Array<{
      name: string;
      value?: string | null;
    }>;
  },
): Promise<void> {
  for (const field of input.fields) {
    const value = field.value?.trim();
    if (!value) continue;
    const reason = classifySensitiveMemoryMaterial(value);
    if (!reason) continue;
    MemoryService.incrementCounter('facts_filtered_sensitive_total');
    await this.store.recordEvent(
      'sensitive_material_filtered',
      'memory_write',
      input.groupFolder,
      {
        actor: input.actor,
        scope: input.scope,
        field: field.name,
        reason,
      },
    );
    throw new Error(
      `sensitive material blocked in memory write (${field.name})`,
    );
  }
}

export async function persistEmbeddingBestEffort(
  this: MemoryService,
  memory: MemoryItem,
  embedding: number[] | null,
  actor: string,
): Promise<void> {
  if (!embedding) return;
  try {
    await this.store.saveItemEmbedding(memory.id, embedding);
  } catch (err) {
    logger.warn(
      {
        err,
        itemId: memory.id,
        scope: memory.scope,
        group_folder: memory.group_folder,
        actor,
      },
      'memory_embedding_persist_failed',
    );
    await this.store.recordEvent(
      'memory_embedding_persist_failed',
      'memory_item',
      memory.id,
      {
        scope: memory.scope,
        group_folder: memory.group_folder,
        actor,
        reason: err instanceof Error ? err.message : String(err),
        fallback: 'keyword_only',
      },
    );
  }
}

export function appendJournal(
  this: MemoryService,
  input: JournalAppendInput,
): void {
  try {
    this.journal.append(input);
  } catch (err) {
    MemoryService.incrementCounter('journal_writes_failed_total');
    logger.error(
      {
        err,
        kind: input.kind,
        group_folder: input.group_folder,
        actor: input.actor,
      },
      'journal_write_failed',
    );
    this.store
      .recordEvent(
        'journal_write_failed',
        'memory_journal',
        input.group_folder,
        {
          kind: input.kind,
          actor: input.actor,
          error: err instanceof Error ? err.message : String(err || 'unknown'),
        },
      )
      .catch((recordErr) => {
        logger.error({ err: recordErr }, 'journal_write_failed_record_failed');
      });
  }
}