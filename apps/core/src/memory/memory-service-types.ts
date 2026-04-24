import type { MemoryItem } from './memory-types.js';

export interface SearchInput {
  query: string;
  groupFolder: string;
  userId?: string;
  threadId?: string;
  limit?: number;
}

export interface TranscriptExtractionInput {
  groupFolder: string;
  transcriptPath: string;
  trigger: 'precompact' | 'session-end';
  sessionId?: string;
  userId?: string;
}

export interface BuildBriefInput {
  groupFolder: string;
  maxItems: number;
  userId?: string;
  threadId?: string;
}

export interface ArcTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface MemoryStatusSnapshot {
  items_by_kind: Record<string, number>;
  items_by_scope: Record<string, number>;
  top10_most_used: Array<{ key: string; retrieval_count: number }>;
  top10_stalest: Array<{ key: string; updated_at: string }>;
  last_dream_run?: { at?: string; summary?: string };
  disk_kb?: Record<string, number>;
}

export interface MemoryServiceCounters {
  extractions_total: number;
  extractions_failed_total: number;
  facts_saved_total: number;
  facts_filtered_sensitive_total: number;
  journal_writes_failed_total: number;
  stale_patch_retries_total: number;
  dreaming_sweeps_total: number;
  cache_read_tokens_total: number;
  cache_creation_tokens_total: number;
}

export interface SourceDoc {
  sourceId: string;
  sourcePath: string;
  sourceType: string;
  text: string;
}

export interface PatchItemWithRetryInput {
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
}