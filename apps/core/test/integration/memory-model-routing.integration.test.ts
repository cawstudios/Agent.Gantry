import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '@core/memory/memory-types.js';
import type { MemoryStore } from '@core/memory/persistence/store.js';

const runClaudeQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@core/memory/claude-query.js', () => ({
  runClaudeQuery: runClaudeQueryMock,
  hasClaudeAuthConfigured: () => true,
}));

function mockConfigEnvModule(values: Record<string, string> = {}) {
  const readValue = (key: string) =>
    process.env[key]?.trim() || values[key]?.trim() || '';
  return {
    envConfig: values,
    envValue: readValue,
    envValueDynamic: readValue,
  };
}

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-model-routing-'));
  tempRoots.push(root);
  return root;
}

function makeMemoryItem(
  overrides: Partial<MemoryItem> & Pick<MemoryItem, 'id' | 'key' | 'value'>,
): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    scope: overrides.scope ?? 'group',
    group_folder: overrides.group_folder ?? 'team',
    user_id: overrides.user_id ?? null,
    topic_id: overrides.topic_id ?? null,
    kind: overrides.kind ?? 'fact',
    key: overrides.key,
    value: overrides.value,
    why: overrides.why,
    load_bearing: overrides.load_bearing ?? false,
    source_turn_id: overrides.source_turn_id ?? null,
    source: overrides.source ?? 'test',
    confidence: overrides.confidence ?? 0.8,
    is_pinned: overrides.is_pinned ?? false,
    superseded_by: overrides.superseded_by ?? null,
    is_deleted: overrides.is_deleted ?? false,
    deleted_at: overrides.deleted_at ?? null,
    last_reviewed_at: overrides.last_reviewed_at ?? null,
    version: overrides.version ?? 1,
    last_used_at: overrides.last_used_at ?? null,
    last_retrieved_at: overrides.last_retrieved_at ?? now,
    retrieval_count: overrides.retrieval_count ?? 0,
    total_score: overrides.total_score ?? 0,
    max_score: overrides.max_score ?? 0,
    query_hashes_json: overrides.query_hashes_json ?? '[]',
    recall_days_json: overrides.recall_days_json ?? '[]',
    embedding_json: overrides.embedding_json ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

function createInMemoryStore(seed: MemoryItem[] = []): MemoryStore {
  const items = new Map(seed.map((item) => [item.id, item]));
  let nextId = seed.length + 1;
  const store = {
    async listActiveItems(groupFolder: string, limit: number) {
      return [...items.values()]
        .filter(
          (item) =>
            !item.is_deleted &&
            item.scope === 'group' &&
            item.group_folder === groupFolder,
        )
        .slice(0, limit);
    },
    async adjustConfidence(ids: string[], delta: number) {
      for (const id of ids) {
        const item = items.get(id);
        if (item) {
          item.confidence = Math.max(0, Math.min(1, item.confidence + delta));
        }
      }
    },
    async getItemById(id: string) {
      return items.get(id) ?? null;
    },
    async pinItem(id: string, pinned: boolean) {
      const item = items.get(id);
      if (item) item.is_pinned = pinned;
    },
    async patchItem(
      id: string,
      _expectedVersion: number,
      patch: Partial<MemoryItem>,
    ) {
      const item = items.get(id);
      if (!item) return null;
      Object.assign(item, patch, { version: item.version + 1 });
      return item;
    },
    async softDeleteItem(id: string, supersededBy?: string) {
      const item = items.get(id);
      if (item) {
        item.is_deleted = true;
        item.superseded_by = supersededBy ?? null;
      }
    },
    async recordEvent() {},
    async saveItem(input: {
      scope?: MemoryItem['scope'];
      group_folder?: string;
      user_id?: string | null;
      kind?: MemoryItem['kind'];
      key: string;
      value: string;
      why?: string;
      source?: string;
      confidence?: number;
      is_pinned?: boolean;
    }) {
      const item = makeMemoryItem({
        id: `item-${nextId++}`,
        scope: input.scope ?? 'group',
        group_folder: input.group_folder ?? 'team',
        user_id: input.user_id ?? null,
        kind: input.kind ?? 'fact',
        key: input.key,
        value: input.value,
        why: input.why,
        source: input.source ?? 'test',
        confidence: input.confidence ?? 0.8,
        is_pinned: input.is_pinned ?? false,
      });
      items.set(item.id, item);
      return item;
    },
    async saveItemEmbedding(id: string, embedding: number[]) {
      const item = items.get(id);
      if (item) item.embedding_json = JSON.stringify(embedding);
    },
  };
  return store as unknown as MemoryStore;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('@core/config/env/index.js');
  vi.doUnmock('@core/config/settings/runtime-settings.js');
  runClaudeQueryMock.mockReset();
});

describe('memory model routing integration', () => {
  it('routes extractor/dreaming/consolidation to per-task runtime models', async () => {
    const runtimeRoot = makeTempRoot();
    vi.stubEnv('MYCLAW_HOME', runtimeRoot);
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-test-token');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-opus-fallback');

    vi.doMock('@core/config/env/index.js', () => mockConfigEnvModule());
    vi.doMock('@core/config/settings/runtime-settings.js', () => ({
      readRuntimeMemorySettingsSnapshot: () => ({
        llmExtractorModel: 'model-extractor-custom',
        llmDreamingModel: 'model-dreaming-custom',
        llmConsolidationModel: 'model-consolidation-custom',
      }),
      readRuntimeStorageSettingsSnapshot: () => ({
        postgresUrlEnv: 'MYCLAW_DATABASE_URL',
        postgresSchema: 'myclaw',
      }),
    }));

    runClaudeQueryMock.mockImplementation(
      async ({ model }: { model: string }) => {
        if (model === 'model-extractor-custom') {
          return JSON.stringify([
            {
              scope: 'group',
              kind: 'fact',
              key: 'fact:style',
              value: 'Use concise responses',
              why: 'Preference: use concise responses.',
              confidence: 0.91,
            },
          ]);
        }
        if (model === 'model-dreaming-custom') {
          return '[]';
        }
        if (model === 'model-consolidation-custom') {
          return JSON.stringify({
            key: 'consolidated:deploy_policy',
            value: 'Always run tests before deploy',
            confidence: 0.9,
          });
        }
        return '';
      },
    );

    const [
      { createLlmMemoryExtractionProvider },
      { runDreamingSweep },
      { consolidateMemoryItems },
    ] = await Promise.all([
      import('@core/memory/extractor-llm.js'),
      import('@core/memory/memory-dreaming.js'),
      import('@core/memory/memory-consolidation.js'),
    ]);

    const extractorFallback = {
      providerName: 'fallback',
      extractFacts: vi.fn(async () => []),
    };
    const extractor = createLlmMemoryExtractionProvider(extractorFallback);
    const extracted = await extractor.extractFacts({
      turns: [
        { role: 'user', text: 'Preference: use concise responses.' },
        {
          role: 'assistant',
          text: 'Acknowledged. I will keep replies concise.',
        },
      ],
      trigger: 'session-end',
      retrievedItems: [],
    });
    expect(extracted.length).toBe(1);

    const dreamed = makeMemoryItem({
      id: 'dream-1',
      key: 'fact:dream',
      value: 'dream candidate',
      confidence: 0.7,
      retrieval_count: 2,
      total_score: 1.7,
      max_score: 0.9,
      query_hashes_json: JSON.stringify(['q-1', 'q-2']),
    });
    const dreamingStore = createInMemoryStore([dreamed]);
    await runDreamingSweep({
      groupFolder: 'team',
      store: dreamingStore,
      enabled: true,
      consolidateGroupMemory: async () => ({
        enabled: true,
        consideredItems: 1,
        clustersFound: 0,
        clustersProcessed: 0,
        mergedItems: 0,
        retiredItems: 0,
        mode: 'none',
      }),
      retentionPinThreshold: 0.95,
      promotionThreshold: 0.3,
      decayThreshold: 0.1,
      minRecalls: 1,
      minUniqueQueries: 1,
      confidenceBoost: 0.05,
      confidenceDecay: 0.03,
      dryRun: true,
    });

    const vector = (() => {
      const out = new Array<number>(3072).fill(0);
      out[0] = 1;
      return out;
    })();
    const consolidationStore = createInMemoryStore([
      makeMemoryItem({
        id: 'deploy-1',
        key: 'deploy:one',
        value: 'Run tests before deploy',
        confidence: 0.8,
      }),
      makeMemoryItem({
        id: 'deploy-2',
        key: 'deploy:two',
        value: 'Always run test suite before release',
        confidence: 0.82,
      }),
    ]);
    await consolidateMemoryItems({
      groupFolder: 'team',
      store: consolidationStore,
      embeddings: {
        isEnabled: () => true,
        validateConfiguration: () => undefined,
        embedMany: async (texts: string[]) => texts.map(() => vector),
        embedOne: async () => vector,
      },
      minItems: 2,
      clusterThreshold: 0.7,
      maxClusters: 3,
    });

    const calledModels = runClaudeQueryMock.mock.calls
      .map((call) => call[0]?.model)
      .filter((value): value is string => typeof value === 'string');
    expect(calledModels).toContain('model-extractor-custom');
    expect(calledModels).toContain('model-dreaming-custom');
    expect(calledModels).toContain('model-consolidation-custom');
    expect(calledModels).not.toContain('claude-opus-fallback');
  });
});