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

export async function ingestGroupSources(
  this: MemoryService,
  groupFolder: string,
): Promise<void> {
  const files: SourceDoc[] = [];
  const groupDir = path.join(AGENTS_DIR, groupFolder);

  const claudePath = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(claudePath)) {
    files.push({
      sourceId: `claude:${groupFolder}`,
      sourcePath: claudePath,
      sourceType: 'claude_md',
      text: fs.readFileSync(claudePath, 'utf-8'),
    });
  }
  files.push(
    ...this.collectMarkdownDocs(
      path.join(groupDir, 'knowledge'),
      (filePath, relPath) => ({
        sourceId: `local_doc:${groupFolder}:${relPath}`,
        sourcePath: filePath,
        sourceType: 'local_doc',
        text: fs.readFileSync(filePath, 'utf-8'),
      }),
    ),
  );

  await this.ingestDocuments(files, 'group', groupFolder);

  await this.applyRetentionWithJournal(groupFolder, 'retention:ingest');
}

export async function ingestGlobalKnowledge(
  this: MemoryService,
  dirOverride?: string,
): Promise<void> {
  const knowledgeDir = dirOverride || MEMORY_GLOBAL_KNOWLEDGE_DIR;
  if (!knowledgeDir) return;
  if (!fs.existsSync(knowledgeDir)) return;

  const docs = this.collectMarkdownDocs(knowledgeDir, (filePath, relPath) => ({
    sourceId: `knowledge_doc:${relPath}`,
    sourcePath: filePath,
    sourceType: 'knowledge_doc',
    text: fs.readFileSync(filePath, 'utf-8'),
  }));
  if (docs.length === 0) return;

  await this.ingestDocuments(docs, 'global', MEMORY_GLOBAL_GROUP_FOLDER);
  await this.applyRetentionWithJournal(
    MEMORY_GLOBAL_GROUP_FOLDER,
    'retention:global',
  );
}

export function collectMarkdownDocs(
  this: MemoryService,
  rootDir: string,
  toSourceDoc: (filePath: string, relPath: string) => SourceDoc,
): SourceDoc[] {
  if (!fs.existsSync(rootDir)) return [];

  const docs: SourceDoc[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }
      const relPath = path.relative(rootDir, nextPath).replace(/\\/g, '/');
      docs.push(toSourceDoc(nextPath, relPath));
    }
  }

  return docs;
}

export async function ingestDocuments(
  this: MemoryService,
  files: SourceDoc[],
  scope: MemoryScope,
  groupFolder: string,
): Promise<void> {
  for (const file of files) {
    const baseImportance = Math.max(
      0,
      MEMORY_SOURCE_TYPE_BOOSTS[file.sourceType] ?? 1,
    );
    const chunks: ChunkInsert[] = chunkText(
      file.text,
      MEMORY_CHUNK_SIZE,
      MEMORY_CHUNK_OVERLAP,
    )
      .map((text) => text.trim())
      .filter((text) => text.length > 30)
      .map((text) => ({
        source_type: file.sourceType,
        source_id: file.sourceId,
        source_path: file.sourcePath,
        scope,
        group_folder: groupFolder,
        kind: file.sourceType,
        text,
        importance_weight: baseImportance,
        embedding: null as number[] | null,
      }));

    if (chunks.length === 0) continue;
    const newChunks = [];
    for (const chunk of chunks) {
      if (!(await this.store.chunkExists(chunk))) {
        newChunks.push(chunk);
      }
    }
    if (newChunks.length === 0) continue;

    const vectors = await this.embeddings.embedMany(
      newChunks.map((chunk) => chunk.text),
    );
    if (vectors.length !== newChunks.length) {
      throw new Error(
        `embedding provider returned ${vectors.length} vectors for ${newChunks.length} chunks`,
      );
    }
    newChunks.forEach((chunk, index) => {
      chunk.embedding = vectors[index] || null;
    });
    await this.store.saveChunks(newChunks);
  }
}