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

export async function reindexFiles(
  this: MemoryService,
): Promise<{ scanned: number; reindexed: number }> {
  return await this.indexer.reindexStaleFilesAndWait();
}

export async function consolidateGroupMemory(
  this: MemoryService,
  groupFolder: string,
): Promise<ConsolidationResult> {
  return consolidateMemoryItems({
    groupFolder,
    store: this.store,
    embeddings: this.embeddings,
    minItems: MEMORY_CONSOLIDATION_MIN_ITEMS,
    clusterThreshold: MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD,
    maxClusters: MEMORY_CONSOLIDATION_MAX_CLUSTERS,
  });
}

export async function runDreamingSweep(
  this: MemoryService,
  groupFolder: string,
): Promise<DreamingResult> {
  MemoryService.incrementCounter('dreaming_sweeps_total');
  return runMemoryDreamingSweep({
    groupFolder,
    store: this.store,
    consolidateGroupMemory: (targetGroupFolder) =>
      this.consolidateGroupMemory(targetGroupFolder),
    retentionPinThreshold: MEMORY_RETENTION_PIN_THRESHOLD,
    promotionThreshold: MEMORY_DREAMING_PROMOTION_THRESHOLD,
    decayThreshold: MEMORY_DREAMING_DECAY_THRESHOLD,
    minRecalls: MEMORY_DREAMING_MIN_RECALLS,
    minUniqueQueries: MEMORY_DREAMING_MIN_UNIQUE_QUERIES,
    confidenceBoost: MEMORY_DREAMING_CONFIDENCE_BOOST,
    confidenceDecay: MEMORY_DREAMING_CONFIDENCE_DECAY,
    enabled: RUNTIME_MEMORY_DREAMING_ENABLED,
  });
}