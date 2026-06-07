import { describe, expect, it } from 'vitest';

import { formatMemoryStatus } from '@core/session/session-command-format.js';

describe('formatMemoryStatus', () => {
  it('reports full-text baseline when semantic recall is off', () => {
    const text = formatMemoryStatus({
      memory_enabled: true,
      items_by_kind: { reference: 1, fact: 2 },
      items_by_scope: { group: 2, common: 1 },
      top10_most_used: [{ key: 'fact:key', retrieval_count: 12 }],
      top10_stalest: [],
      memory_pipeline: {
        staged: 3,
        promoted: 2,
        needs_review: 1,
      },
      last_injected_block: {
        subject: 'channel:team',
        bytes: 4096,
        at: '2026-05-08T00:00:00.000Z',
      },
      retrieval: {
        searchMode: 'lexical_keyword',
        embeddings: 'disabled',
        vectorSearch: 'inactive',
        ready: 0,
        pending: 4,
      },
    });

    expect(text).toBe(
      [
        'Memory: on',
        'Pre-answer recall: on',
        'Search mode: full-text',
        'Semantic recall: off (optional)',
        'Semantic index: 0 ready, 4 pending',
        'Last dream: never',
        'Review queue: 1',
        'Injected this run: 1',
      ].join('\n'),
    );
  });

  it('reports disabled memory explicitly', () => {
    const text = formatMemoryStatus({
      memory_enabled: false,
      items_by_kind: {},
      items_by_scope: {},
      top10_most_used: [],
      top10_stalest: [],
    });

    expect(text).toBe(
      [
        'Memory: off',
        'Pre-answer recall: off',
        'Search mode: full-text',
        'Semantic recall: off (optional)',
        'Last dream: never',
        'Review queue: 0',
        'Injected this run: 0',
      ].join('\n'),
    );
  });

  it('reports hybrid partial search mode while indexing is in progress', () => {
    const text = formatMemoryStatus({
      memory_enabled: true,
      items_by_kind: {},
      items_by_scope: {},
      top10_most_used: [],
      top10_stalest: [],
      retrieval: {
        searchMode: 'hybrid_semantic_partial',
        embeddings: 'configured',
        vectorSearch: 'partial',
        ready: 6,
        pending: 4,
      },
    });

    expect(text).toContain('Search mode: hybrid partial');
    expect(text).toContain('Semantic recall: on (index building)');
    expect(text).toContain('Semantic index: 6 ready, 4 pending');
  });

  it('keeps the recall line consistent when a partial index is paused', () => {
    const text = formatMemoryStatus({
      memory_enabled: true,
      items_by_kind: {},
      items_by_scope: {},
      top10_most_used: [],
      top10_stalest: [],
      retrieval: {
        searchMode: 'hybrid_semantic_partial',
        embeddings: 'configured',
        vectorSearch: 'partial',
        pauseReason: 'paused_rate_limit',
        ready: 6,
        pending: 4,
      },
    });

    // Search mode says hybrid is active, so the recall line must not claim
    // semantic is off / full-text only — it reports the build pause instead.
    expect(text).toContain('Search mode: hybrid partial');
    expect(text).toContain(
      'Semantic recall: on (index build paused: embedding provider rate limit)',
    );
    expect(text).not.toContain('Full-text memory is still active');
  });

  it('reports hybrid search mode when the index is fully ready', () => {
    const text = formatMemoryStatus({
      memory_enabled: true,
      items_by_kind: {},
      items_by_scope: {},
      top10_most_used: [],
      top10_stalest: [],
      retrieval: {
        searchMode: 'hybrid_semantic_ready',
        embeddings: 'configured',
        vectorSearch: 'active',
        ready: 10,
        pending: 0,
      },
    });

    expect(text).toContain('Search mode: hybrid');
    expect(text).toContain('Semantic recall: on');
    expect(text).toContain('Semantic index: 10 ready, 0 pending');
  });

  it('reports semantic recall as paused while keeping full-text active', () => {
    const text = formatMemoryStatus({
      memory_enabled: true,
      items_by_kind: {},
      items_by_scope: {},
      top10_most_used: [],
      top10_stalest: [],
      retrieval: {
        searchMode: 'lexical_keyword',
        embeddings: 'configured',
        vectorSearch: 'inactive',
        pauseReason: 'paused_budget',
        ready: 2,
        pending: 8,
      },
    });

    expect(text).toContain('Search mode: full-text');
    expect(text).toContain(
      'Semantic recall paused: daily embedding budget reached. Full-text memory is still active.',
    );
  });
});
