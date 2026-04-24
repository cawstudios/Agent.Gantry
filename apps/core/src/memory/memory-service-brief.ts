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

export async function buildBrief(
  this: MemoryService,
  input: BuildBriefInput,
): Promise<string> {
  if (!RUNTIME_MEMORY_ENABLED) return 'No durable memory available yet.';
  const resolvedUserId = input.userId?.trim() || undefined;
  const topicId = normalizeMemoryTopicId(input.threadId);
  const userScopedItems = resolvedUserId
    ? await this.store.listTopItems(
        'user',
        input.groupFolder,
        input.maxItems,
        resolvedUserId,
      )
    : [];
  const groupScopedItems = await this.store.listTopItems(
    'group',
    input.groupFolder,
    input.maxItems,
    undefined,
    topicId,
  );
  const globalScopedItems = await this.store.listTopItems(
    'global',
    input.groupFolder,
    input.maxItems,
    undefined,
    topicId,
  );
  const scoped = dedupeItemsById([
    ...userScopedItems,
    ...groupScopedItems,
    ...globalScopedItems,
  ])
    .sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) {
        return Number(b.is_pinned) - Number(a.is_pinned);
      }
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      const aLast = Date.parse(a.last_retrieved_at || a.updated_at);
      const bLast = Date.parse(b.last_retrieved_at || b.updated_at);
      return bLast - aLast;
    })
    .slice(0, input.maxItems);
  const procedures = await this.store.listTopProcedures(
    input.groupFolder,
    5,
    topicId,
  );

  const decisions = scoped.filter((item) => item.kind === 'decision');
  const facts = scoped.filter((item) => item.kind !== 'decision');
  const latestSessionRecap = topicId
    ? null
    : MemoryRootService.getInstance().getLatestSessionRecap(input.groupFolder);
  const latestDreamEvent =
    (await this.store.getLatestEvent('dream_completed', input.groupFolder)) ||
    (await this.store.getLatestEvent('dreaming_completed', input.groupFolder));

  const lines: string[] = ['## Memory Brief', ''];
  if (topicId) {
    lines.push('### Topic Boundary');
    lines.push(`- thread_id: ${normalizeSingleLine(topicId)}`);
    lines.push(
      '- injected memories are limited to records explicitly saved for this thread_id',
    );
    lines.push('');
  }
  if (latestSessionRecap) {
    lines.push('### Session Recap');
    lines.push(
      `- Summary: ${truncate(normalizeSingleLine(latestSessionRecap.summary), 260)}`,
    );
    lines.push(
      `- Open loops: ${truncate(normalizeSingleLine(latestSessionRecap.openLoops), 260)}`,
    );
    lines.push('');
  }

  lines.push('### Dream Lifecycle');
  lines.push(
    `- dreaming_enabled: ${RUNTIME_MEMORY_DREAMING_ENABLED ? 'yes' : 'no'}`,
  );
  if (RUNTIME_MEMORY_DREAMING_ENABLED) {
    lines.push(`- schedule: ${MEMORY_DREAMING_CRON}`);
  }
  if (latestDreamEvent) {
    let summary = 'summary unavailable';
    try {
      const payload = JSON.parse(latestDreamEvent.payload_json) as {
        promotedCount?: number;
        decayedCount?: number;
        retiredCount?: number;
      };
      summary = `promoted=${payload.promotedCount ?? 0}, decayed=${payload.decayedCount ?? 0}, retired=${payload.retiredCount ?? 0}`;
    } catch {
      summary = 'summary unavailable';
    }
    lines.push(`- last_run: ${latestDreamEvent.created_at}`);
    lines.push(`- last_result: ${summary}`);
  } else {
    lines.push('- last_run: never');
  }
  lines.push('');

  if (decisions.length > 0) {
    lines.push('### Active Decisions');
    for (const item of decisions) {
      lines.push(`- (${item.scope}) ${truncate(item.value, 220)}`);
    }
    lines.push('');
  }

  if (facts.length > 0) {
    lines.push('### Facts');
    for (const item of facts) {
      lines.push(`- (${item.scope}) ${truncate(item.value, 220)}`);
    }
    lines.push('');
  }

  if (procedures.length > 0) {
    lines.push('### Procedures');
    for (const procedure of procedures) {
      lines.push(
        `- **${truncate(procedure.title, 120)}**: ${truncate(procedure.body, 220)}`,
      );
    }
    lines.push('');
  }

  if (decisions.length === 0 && facts.length === 0 && procedures.length === 0) {
    lines.push('No durable memory available yet.');
    lines.push('');
  }

  return lines.join('\n').trim();
}