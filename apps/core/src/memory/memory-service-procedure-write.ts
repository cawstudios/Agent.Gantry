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

export async function saveProcedure(
  this: MemoryService,
  input: SaveProcedureInput,
  ctx: MemoryWriteContext,
): Promise<MemoryProcedure> {
  if (!RUNTIME_MEMORY_ENABLED) {
    throw new Error('memory is disabled');
  }
  const scope = this.resolveScope(input.scope, ctx);
  if (scope === 'user') {
    throw new Error('user-scoped procedures are not supported');
  }
  this.enforceScope(scope, ctx);
  const groupFolder = this.resolveTargetGroupFolder(input.group_folder, ctx);
  const topicId = normalizeMemoryTopicId(input.topic_id || ctx.threadId);
  const actor = this.resolveWriteActor(ctx, input.source || 'agent');
  await this.assertNoSensitiveMaterialOrThrow({
    groupFolder,
    actor,
    scope,
    fields: [
      { name: 'title', value: input.title },
      { name: 'body', value: input.body },
    ],
  });

  const procedure = await this.store.saveProcedure({
    scope,
    group_folder: groupFolder,
    topic_id: topicId || null,
    title: input.title,
    body: input.body,
    tags: input.tags || [],
    source: input.source || 'agent',
    origin: input.origin || 'explicit',
    trigger: input.trigger || null,
    confidence: clampConfidence(input.confidence),
  });

  await this.store.recordEvent(
    'procedure_saved',
    'memory_procedure',
    procedure.id,
    {
      scope: procedure.scope,
      title: procedure.title,
      confidence: procedure.confidence,
    },
  );
  this.appendJournal({
    kind: 'memory.procedure.saved',
    group_folder: procedure.group_folder,
    scope: procedure.scope,
    actor,
    payload: procedure,
  });

  return procedure;
}

export async function patchProcedure(
  this: MemoryService,
  input: PatchProcedureInput,
  ctx: MemoryWriteContext,
): Promise<MemoryProcedure> {
  if (!RUNTIME_MEMORY_ENABLED) {
    throw new Error('memory is disabled');
  }
  const existing = await this.store.getProcedureById(input.id);
  if (!existing) throw new Error('memory procedure not found');
  this.enforcePatchAccess(existing.scope, existing.group_folder, ctx);
  const actor = this.resolveWriteActor(ctx, existing.source);
  await this.assertNoSensitiveMaterialOrThrow({
    groupFolder: existing.group_folder,
    actor,
    scope: existing.scope,
    fields: [
      { name: 'title', value: input.title },
      { name: 'body', value: input.body },
    ],
  });
  const patched = await this.store.patchProcedure(
    input.id,
    input.expected_version,
    {
      title: input.title,
      body: input.body,
      tags: input.tags,
      trigger: input.trigger,
      confidence: input.confidence,
    },
  );

  await this.store.recordEvent(
    'procedure_patched',
    'memory_procedure',
    patched.id,
    {
      version: patched.version,
      confidence: patched.confidence,
    },
  );
  this.appendJournal({
    kind: 'memory.procedure.patched',
    group_folder: patched.group_folder,
    scope: patched.scope,
    actor,
    payload: patched,
  });

  return patched;
}