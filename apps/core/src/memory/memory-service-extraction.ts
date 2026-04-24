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
  MEMORY_EXTRACTOR_MAX_TURNS,
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

export async function extractFromTranscript(
  this: MemoryService,
  input: TranscriptExtractionInput,
): Promise<void> {
  if (!RUNTIME_MEMORY_ENABLED) return;
  MemoryService.incrementCounter('extractions_total');
  try {
    const resolvedUserId = input.userId?.trim() || undefined;
    const turns = parseTranscriptArc(
      input.transcriptPath,
      MEMORY_EXTRACTOR_MAX_TURNS,
    );
    if (turns.length === 0) {
      const payload = {
        group_folder: input.groupFolder,
        trigger: input.trigger,
        transcript_path: input.transcriptPath,
        session_id: input.sessionId || null,
        facts_extracted: 0,
        facts_saved: 0,
      };
      await this.store.recordEvent(
        'reflection_completed',
        'reflection',
        input.groupFolder,
        payload,
      );
      this.appendJournal({
        kind: 'reflection.completed',
        group_folder: input.groupFolder,
        actor: `extractor:${input.trigger}`,
        payload,
      });
      return;
    }

    const userScopedItems = resolvedUserId
      ? await this.store.listTopItems(
          'user',
          input.groupFolder,
          10,
          resolvedUserId,
        )
      : [];
    const groupScopedItems = await this.store.listTopItems(
      'group',
      input.groupFolder,
      10,
    );
    const globalScopedItems = await this.store.listTopItems(
      'global',
      input.groupFolder,
      10,
    );
    const retrievedItems = dedupeItemsById([
      ...groupScopedItems,
      ...globalScopedItems,
      ...userScopedItems,
    ]).slice(0, 10);
    const supersedeCandidatesById = new Map<string, MemoryItem>(
      retrievedItems.map((item) => [item.id, item]),
    );

    let extractorUsage: MemoryExtractorUsage | undefined;
    const extractedFacts = await this.extractor.extractFacts({
      turns,
      trigger: input.trigger,
      userId: resolvedUserId,
      retrievedItems: retrievedItems.map((item) => ({
        id: item.id,
        key: item.key,
        value: item.value,
      })),
      onUsage: (usage) => {
        extractorUsage = usage;
      },
    });
    if (extractorUsage) {
      await this.store.recordEvent(
        'memory_extractor_usage',
        'memory_extractor',
        input.groupFolder,
        {
          trigger: input.trigger,
          model: extractorUsage.model,
          input_tokens: extractorUsage.input_tokens,
          output_tokens: extractorUsage.output_tokens,
          cache_read_input_tokens: extractorUsage.cache_read_input_tokens,
          cache_creation_input_tokens:
            extractorUsage.cache_creation_input_tokens,
        },
      );
      MemoryService.incrementCounter(
        'cache_read_tokens_total',
        extractorUsage.cache_read_input_tokens ?? 0,
      );
      MemoryService.incrementCounter(
        'cache_creation_tokens_total',
        extractorUsage.cache_creation_input_tokens ?? 0,
      );
    }

    const writableFacts: typeof extractedFacts = [];
    for (const fact of extractedFacts) {
      if (fact.confidence < MEMORY_EXTRACTOR_MIN_CONFIDENCE) continue;
      const sensitiveKeyReason = classifySensitiveMemoryMaterial(fact.key);
      if (sensitiveKeyReason) {
        MemoryService.incrementCounter('facts_filtered_sensitive_total');
        await this.store.recordEvent(
          'sensitive_material_filtered',
          'memory_extractor',
          input.groupFolder,
          {
            trigger: input.trigger,
            scope: fact.scope,
            key_fingerprint: fingerprintSensitiveToken(fact.key),
            field: 'key',
            reason: sensitiveKeyReason,
          },
        );
        continue;
      }
      const sensitiveValueReason = classifySensitiveMemoryMaterial(fact.value);
      if (sensitiveValueReason) {
        MemoryService.incrementCounter('facts_filtered_sensitive_total');
        await this.store.recordEvent(
          'sensitive_material_filtered',
          'memory_extractor',
          input.groupFolder,
          {
            trigger: input.trigger,
            scope: fact.scope,
            key_fingerprint: fingerprintSensitiveToken(fact.key),
            field: 'value',
            reason: sensitiveValueReason,
          },
        );
        continue;
      }
      const sensitiveWhyReason = fact.why
        ? classifySensitiveMemoryMaterial(fact.why)
        : null;
      if (sensitiveWhyReason) {
        MemoryService.incrementCounter('facts_filtered_sensitive_total');
        await this.store.recordEvent(
          'sensitive_material_filtered',
          'memory_extractor',
          input.groupFolder,
          {
            trigger: input.trigger,
            scope: fact.scope,
            key_fingerprint: fingerprintSensitiveToken(fact.key),
            field: 'why',
            reason: sensitiveWhyReason,
          },
        );
        continue;
      }
      writableFacts.push(fact);
    }

    let factEmbeddings: number[][] = [];
    if (writableFacts.length > 0 && MEMORY_SEMANTIC_DEDUP_ENABLED) {
      factEmbeddings = await this.embeddings.embedMany(
        writableFacts.map((fact) => `${fact.key}: ${fact.value}`),
      );
      if (factEmbeddings.length !== writableFacts.length) {
        throw new Error(
          `embedding provider returned ${factEmbeddings.length} vectors for ${writableFacts.length} facts`,
        );
      }
    }

    let savedFacts = 0;
    for (let i = 0; i < writableFacts.length; i += 1) {
      const fact = writableFacts[i]!;
      if (fact.scope === 'global') {
        continue;
      }
      const saved = await this.saveMemory(
        {
          scope: fact.scope,
          group_folder: input.groupFolder,
          user_id: fact.user_id,
          key: fact.key,
          value: fact.value,
          why: fact.why,
          load_bearing: fact.load_bearing,
          source_turn_id: fact.source_turn_id,
          kind: fact.kind,
          confidence: fact.confidence,
          source: input.trigger,
        },
        {
          isMain: false,
          groupFolder: input.groupFolder,
          actor: `extractor:${input.trigger}`,
        },
        factEmbeddings[i] || null,
      );
      if (Array.isArray(fact.supersedes)) {
        const validSupersedeIds = new Set<string>();
        for (const id of fact.supersedes) {
          if (!id) continue;
          const candidate = supersedeCandidatesById.get(id);
          if (!candidate) continue;
          if (candidate.group_folder !== input.groupFolder) continue;
          if (candidate.scope !== saved.scope) continue;
          if (
            candidate.scope === 'user' &&
            saved.user_id &&
            candidate.user_id !== saved.user_id
          ) {
            continue;
          }
          validSupersedeIds.add(id);
        }
        for (const id of validSupersedeIds) {
          await this.store.softDeleteItem(id, saved.id);
          this.appendJournal({
            kind: 'memory.item.superseded',
            group_folder: input.groupFolder,
            scope: saved.scope,
            actor: `extractor:${input.trigger}`,
            payload: {
              id,
              superseded_by: saved.id,
            },
          });
        }
      }
      savedFacts += 1;
    }
    MemoryService.incrementCounter('facts_saved_total', savedFacts);

    await this.applyRetentionWithJournal(
      input.groupFolder,
      `retention:${input.trigger}`,
    );
    const consolidation = await this.consolidateGroupMemory(input.groupFolder);

    const reflectionPayload = {
      group_folder: input.groupFolder,
      trigger: input.trigger,
      transcript_path: input.transcriptPath,
      session_id: input.sessionId || null,
      facts_extracted: extractedFacts.length,
      facts_saved: savedFacts,
      consolidation,
    };
    await this.store.recordEvent(
      'reflection_completed',
      'reflection',
      input.groupFolder,
      reflectionPayload,
    );
    this.appendJournal({
      kind: 'reflection.completed',
      group_folder: input.groupFolder,
      actor: `extractor:${input.trigger}`,
      payload: reflectionPayload,
    });
  } catch (err) {
    MemoryService.incrementCounter('extractions_failed_total');
    throw err;
  }
}

export async function applyRetentionWithJournal(
  this: MemoryService,
  groupFolder: string,
  actor: string,
): Promise<void> {
  const retention = await this.store.applyRetentionPolicies(groupFolder);
  for (const id of retention.removedItemIds) {
    this.appendJournal({
      kind: 'memory.item.superseded',
      group_folder: groupFolder,
      actor,
      payload: {
        id,
        superseded_by: null,
        reason: 'retention',
      },
    });
  }
  for (const id of retention.removedProcedureIds) {
    this.appendJournal({
      kind: 'memory.procedure.deleted',
      group_folder: groupFolder,
      actor,
      payload: {
        id,
        reason: 'retention',
      },
    });
  }
  if (
    retention.removedItemIds.length > 0 ||
    retention.removedProcedureIds.length > 0 ||
    retention.evictedChunkIds.length > 0
  ) {
    this.appendJournal({
      kind: 'retention.applied',
      group_folder: groupFolder,
      actor,
      payload: {
        removed_item_ids: retention.removedItemIds,
        removed_procedure_ids: retention.removedProcedureIds,
        evicted_chunk_ids: retention.evictedChunkIds,
      },
    });
  }
}