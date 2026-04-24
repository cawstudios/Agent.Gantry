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

export async function getStatus(
  this: MemoryService,
  groupFolder: string,
): Promise<MemoryStatusSnapshot> {
  if (!RUNTIME_MEMORY_ENABLED) {
    return {
      items_by_kind: {},
      items_by_scope: {},
      top10_most_used: [],
      top10_stalest: [],
    };
  }
  const groupItems = await this.store.listActiveItems(groupFolder, 20_000);
  const globalItems = await this.store.listTopItems(
    'global',
    groupFolder,
    5_000,
  );
  const items = dedupeItemsById([...groupItems, ...globalItems]);

  const itemsByKind: Record<string, number> = {};
  const itemsByScope: Record<string, number> = {};
  for (const item of items) {
    itemsByKind[item.kind] = (itemsByKind[item.kind] || 0) + 1;
    itemsByScope[item.scope] = (itemsByScope[item.scope] || 0) + 1;
  }

  const topUsed = [...items]
    .sort((a, b) => b.retrieval_count - a.retrieval_count)
    .slice(0, 10)
    .map((item) => ({
      key: item.key,
      retrieval_count: item.retrieval_count,
    }));
  const topStalest = [...items]
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    .slice(0, 10)
    .map((item) => ({ key: item.key, updated_at: item.updated_at }));

  const latestDream =
    (await this.store.getLatestEvent('dream_completed', groupFolder)) ||
    (await this.store.getLatestEvent('dreaming_completed', groupFolder));
  let lastDreamRun: MemoryStatusSnapshot['last_dream_run'] = undefined;
  if (latestDream) {
    let summary = '';
    try {
      const payload = JSON.parse(latestDream.payload_json) as {
        promotedCount?: number;
        retiredCount?: number;
        decayedCount?: number;
      };
      summary = `promoted=${payload.promotedCount ?? 0}, decayed=${payload.decayedCount ?? 0}, retired=${payload.retiredCount ?? 0}`;
    } catch {
      summary = '';
    }
    lastDreamRun = {
      at: latestDream.created_at,
      ...(summary ? { summary } : {}),
    };
  }

  let diskKb: Record<string, number> | undefined;
  try {
    const layout = {
      itemsDir: path.join(memoryStorageDir, 'items'),
      proceduresDir: path.join(memoryStorageDir, 'procedures'),
      sessionsDir: path.join(memoryStorageDir, 'sessions'),
      journalDir: path.join(memoryStorageDir, '.journal'),
    };
    diskKb = {
      items: directorySizeKb(layout.itemsDir),
      procedures: directorySizeKb(layout.proceduresDir),
      sessions: directorySizeKb(layout.sessionsDir),
      journal: directorySizeKb(layout.journalDir),
    };
  } catch {
    diskKb = undefined;
  }

  return {
    items_by_kind: itemsByKind,
    items_by_scope: itemsByScope,
    top10_most_used: topUsed,
    top10_stalest: topStalest,
    ...(lastDreamRun ? { last_dream_run: lastDreamRun } : {}),
    ...(diskKb ? { disk_kb: diskKb } : {}),
  };
}