/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import path from 'path';

import {
  memoryStorageDir,
  MEMORY_JOURNAL_DISABLED,
  RUNTIME_MEMORY_ENABLED,
} from '../config/index.js';
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from './memory-embeddings.js';
import { CachedEmbeddingProvider } from './memory-embedding-cache.js';
import { createLlmMemoryExtractionProvider } from './extractor-llm.js';
import type { MemoryExtractionProvider } from './extractor-types.js';
import { MemoryStore } from './persistence/store.js';
import { MemoryJournal } from './memory-journal.js';
import { MemoryIndexer } from './memory-indexer.js';
import type { MemoryServiceCounters } from './memory-service-types.js';
import * as briefOps from './memory-service-brief.js';
import * as extractionOps from './memory-service-extraction.js';
import * as ingestOps from './memory-service-ingest.js';
import * as lifecycleOps from './memory-service-lifecycle.js';
import * as searchOps from './memory-service-search.js';
import * as statusOps from './memory-service-status.js';
import * as writeOps from './memory-service-write.js';
export type {
  BuildBriefInput,
  MemoryServiceCounters,
  MemoryStatusSnapshot,
  SearchInput,
  TranscriptExtractionInput,
} from './memory-service-types.js';

const INITIAL_MEMORY_COUNTERS: MemoryServiceCounters = {
  extractions_total: 0,
  extractions_failed_total: 0,
  facts_saved_total: 0,
  facts_filtered_sensitive_total: 0,
  journal_writes_failed_total: 0,
  stale_patch_retries_total: 0,
  dreaming_sweeps_total: 0,
  cache_read_tokens_total: 0,
  cache_creation_tokens_total: 0,
};

let memoryServiceSingleton: MemoryService | null = null;

export class MemoryService {
  private static counters: MemoryServiceCounters = {
    ...INITIAL_MEMORY_COUNTERS,
  };
  readonly store: MemoryStore;
  readonly embeddings: EmbeddingProvider;
  readonly extractor: MemoryExtractionProvider;
  readonly journal: MemoryJournal;
  readonly indexer: MemoryIndexer;

  static incrementCounter(name: keyof MemoryServiceCounters, delta = 1): void {
    const next = (MemoryService.counters[name] || 0) + delta;
    MemoryService.counters[name] = Math.max(0, Number(next) || 0);
  }

  static getCountersSnapshot(): MemoryServiceCounters {
    return { ...MemoryService.counters };
  }

  constructor(
    store: MemoryStore = new MemoryStore(),
    embeddings: EmbeddingProvider = createEmbeddingProvider(),
    extractor: MemoryExtractionProvider = createLlmMemoryExtractionProvider(),
    journal: MemoryJournal = new MemoryJournal(
      path.join(memoryStorageDir, '.journal'),
      MEMORY_JOURNAL_DISABLED,
    ),
  ) {
    this.store = store;
    this.embeddings = new CachedEmbeddingProvider(embeddings, this.store);
    this.extractor = extractor;
    this.journal = journal;
    this.indexer = new MemoryIndexer(
      memoryStorageDir,
      this.store,
      this.embeddings,
    );
    this.embeddings.validateConfiguration();
  }

  static getInstance(): MemoryService {
    if (!memoryServiceSingleton) {
      memoryServiceSingleton = new MemoryService();
    }
    return memoryServiceSingleton;
  }

  static closeInstance(): void {
    memoryServiceSingleton?.journal.close();
    memoryServiceSingleton?.store.close();
    memoryServiceSingleton = null;
  }

  getProviderName(): string {
    return RUNTIME_MEMORY_ENABLED ? 'postgres' : 'disabled';
  }

  getCounters(): MemoryServiceCounters {
    return MemoryService.getCountersSnapshot();
  }
}

type BoundServiceMethods<T> = {
  [K in keyof T]: T[K] extends (
    this: MemoryService,
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Result
    : T[K];
};

export interface MemoryService
  extends
    BoundServiceMethods<typeof lifecycleOps>,
    BoundServiceMethods<typeof statusOps>,
    BoundServiceMethods<typeof ingestOps>,
    BoundServiceMethods<typeof searchOps>,
    BoundServiceMethods<typeof writeOps>,
    BoundServiceMethods<typeof briefOps>,
    BoundServiceMethods<typeof extractionOps> {}

Object.assign(
  MemoryService.prototype,
  lifecycleOps,
  statusOps,
  ingestOps,
  searchOps,
  writeOps,
  briefOps,
  extractionOps,
);