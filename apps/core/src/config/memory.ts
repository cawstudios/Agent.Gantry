import path from 'path';

import { envConfig, envValue } from './env/index.js';
import { parseBooleanEnv } from './env/parse.js';
import {
  memoryStorageDir,
  resolveRuntimeMemoryPath,
  runtimeMemorySettings,
} from './memory-state.js';

export { memoryStorageDir, RUNTIME_MEMORY_ENABLED } from './memory-state.js';
export * from './memory-advanced.js';

const MEMORY_GLOBAL_KNOWLEDGE_DIR_RAW =
  process.env.MEMORY_GLOBAL_KNOWLEDGE_DIR ||
  envConfig.MEMORY_GLOBAL_KNOWLEDGE_DIR ||
  '';

function parseSourceTypeBoosts(
  raw: string | undefined,
  fallback: Record<string, number>,
): Record<string, number> {
  if (!raw?.trim()) return { ...fallback };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return { ...fallback };
    const merged: Record<string, number> = { ...fallback };
    for (const [key, value] of Object.entries(parsed)) {
      const boost = Number(value);
      if (!Number.isFinite(boost) || boost <= 0) continue;
      merged[key] = boost;
    }
    return merged;
  } catch {
    return { ...fallback };
  }
}

export const OPENAI_API_KEY = envValue('OPENAI_API_KEY') || null;
export const OPENAI_DAILY_EMBED_LIMIT = Math.max(
  0,
  parseInt(
    process.env.OPENAI_DAILY_EMBED_LIMIT ||
      envConfig.OPENAI_DAILY_EMBED_LIMIT ||
      '500',
    10,
  ),
);
export const MEMORY_EMBED_MODEL =
  runtimeMemorySettings.embeddingModel || 'text-embedding-3-large';
export const MEMORY_EMBED_PROVIDER =
  runtimeMemorySettings.embeddingsEnabled === false
    ? 'disabled'
    : runtimeMemorySettings.embeddingProvider || 'disabled';
export const MEMORY_CHUNK_SIZE = Math.max(
  300,
  parseInt(
    process.env.MEMORY_CHUNK_SIZE || envConfig.MEMORY_CHUNK_SIZE || '1400',
    10,
  ) || 1400,
);
export const MEMORY_CHUNK_OVERLAP = Math.max(
  0,
  parseInt(
    process.env.MEMORY_CHUNK_OVERLAP || envConfig.MEMORY_CHUNK_OVERLAP || '240',
    10,
  ) || 240,
);
export const MEMORY_RETRIEVAL_LIMIT = Math.max(
  1,
  parseInt(
    process.env.MEMORY_RETRIEVAL_LIMIT ||
      envConfig.MEMORY_RETRIEVAL_LIMIT ||
      '8',
    10,
  ) || 8,
);
export const MEMORY_RETRIEVAL_MIN_SCORE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_RETRIEVAL_MIN_SCORE ||
        envConfig.MEMORY_RETRIEVAL_MIN_SCORE ||
        '0.005',
    ) || 0.005,
  ),
);
export const MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS = Math.max(
  1,
  parseFloat(
    process.env.MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS ||
      envConfig.MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS ||
      '45',
  ) || 45,
);
export const MEMORY_MMR_LAMBDA = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_MMR_LAMBDA || envConfig.MEMORY_MMR_LAMBDA || '0.7',
    ) || 0.7,
  ),
);
export const MEMORY_RRF_LEXICAL_WEIGHT = Math.max(
  0,
  parseFloat(
    process.env.MEMORY_RRF_LEXICAL_WEIGHT ||
      envConfig.MEMORY_RRF_LEXICAL_WEIGHT ||
      '1.0',
  ) || 1.0,
);
export const MEMORY_RRF_VECTOR_WEIGHT = Math.max(
  0,
  parseFloat(
    process.env.MEMORY_RRF_VECTOR_WEIGHT ||
      envConfig.MEMORY_RRF_VECTOR_WEIGHT ||
      '1.0',
  ) || 1.0,
);

const DEFAULT_MEMORY_SOURCE_TYPE_BOOSTS: Record<string, number> = {
  claude_md: 1.3,
  local_doc: 1.2,
  knowledge_doc: 1.4,
  conversation: 1.0,
};
export const MEMORY_SOURCE_TYPE_BOOSTS = parseSourceTypeBoosts(
  process.env.MEMORY_SOURCE_TYPE_BOOSTS || envConfig.MEMORY_SOURCE_TYPE_BOOSTS,
  DEFAULT_MEMORY_SOURCE_TYPE_BOOSTS,
);
export const MEMORY_EXTRACTOR_MAX_FACTS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_EXTRACTOR_MAX_FACTS ||
      envConfig.MEMORY_EXTRACTOR_MAX_FACTS ||
      '8',
    10,
  ) || 8,
);
export const MEMORY_EXTRACTOR_MIN_CONFIDENCE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_EXTRACTOR_MIN_CONFIDENCE ||
        envConfig.MEMORY_EXTRACTOR_MIN_CONFIDENCE ||
        '0.6',
    ) || 0.6,
  ),
);
export const MEMORY_EXTRACTOR_MAX_TURNS = Math.max(
  10,
  parseInt(
    process.env.MEMORY_EXTRACTOR_MAX_TURNS ||
      envConfig.MEMORY_EXTRACTOR_MAX_TURNS ||
      '60',
    10,
  ) || 60,
);
export const MEMORY_REFLECTION_MIN_CONFIDENCE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_REFLECTION_MIN_CONFIDENCE ||
        envConfig.MEMORY_REFLECTION_MIN_CONFIDENCE ||
        '0.7',
    ) || 0.7,
  ),
);
export const MEMORY_REFLECTION_MAX_FACTS_PER_TURN = Math.max(
  1,
  parseInt(
    process.env.MEMORY_REFLECTION_MAX_FACTS_PER_TURN ||
      envConfig.MEMORY_REFLECTION_MAX_FACTS_PER_TURN ||
      '6',
    10,
  ) || 6,
);
export const MEMORY_SCOPE_POLICY =
  process.env.MEMORY_SCOPE_POLICY || envConfig.MEMORY_SCOPE_POLICY || 'group';
export const MEMORY_RETENTION_PIN_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_RETENTION_PIN_THRESHOLD ||
        envConfig.MEMORY_RETENTION_PIN_THRESHOLD ||
        '0.92',
    ) || 0.92,
  ),
);
export const MEMORY_ITEM_MAX_PER_GROUP = Math.max(
  100,
  parseInt(
    process.env.MEMORY_ITEM_MAX_PER_GROUP ||
      envConfig.MEMORY_ITEM_MAX_PER_GROUP ||
      '2000',
    10,
  ) || 2000,
);
export const MEMORY_SEMANTIC_DEDUP_ENABLED = parseBooleanEnv(
  process.env.MEMORY_SEMANTIC_DEDUP_ENABLED ||
    envConfig.MEMORY_SEMANTIC_DEDUP_ENABLED,
  true,
);
export const MEMORY_SEMANTIC_DEDUP_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_SEMANTIC_DEDUP_THRESHOLD ||
        envConfig.MEMORY_SEMANTIC_DEDUP_THRESHOLD ||
        '0.88',
    ) || 0.88,
  ),
);
export const MEMORY_GLOBAL_KNOWLEDGE_DIR = resolveRuntimeMemoryPath(
  MEMORY_GLOBAL_KNOWLEDGE_DIR_RAW || path.join(memoryStorageDir, 'knowledge'),
);
export const MEMORY_KNOWLEDGE_EMBED_BUDGET_PER_DAY = Math.max(
  0,
  parseInt(
    process.env.MEMORY_KNOWLEDGE_EMBED_BUDGET_PER_DAY ||
      envConfig.MEMORY_KNOWLEDGE_EMBED_BUDGET_PER_DAY ||
      '200',
    10,
  ) || 200,
);
export const MEMORY_MAX_GLOBAL_CHUNKS = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAX_GLOBAL_CHUNKS ||
      envConfig.MEMORY_MAX_GLOBAL_CHUNKS ||
      '3000',
    10,
  ) || 3000,
);
export const MEMORY_USAGE_FEEDBACK_ENABLED = parseBooleanEnv(
  process.env.MEMORY_USAGE_FEEDBACK_ENABLED ||
    envConfig.MEMORY_USAGE_FEEDBACK_ENABLED,
  true,
);
export const MEMORY_CONFIDENCE_BOOST_ON_USE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_CONFIDENCE_BOOST_ON_USE ||
        envConfig.MEMORY_CONFIDENCE_BOOST_ON_USE ||
        '0.02',
    ) || 0.02,
  ),
);
export const MEMORY_CONFIDENCE_DECAY_ON_UNUSED = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_CONFIDENCE_DECAY_ON_UNUSED ||
        envConfig.MEMORY_CONFIDENCE_DECAY_ON_UNUSED ||
        '0.01',
    ) || 0.01,
  ),
);
export const MEMORY_USAGE_DECAY_INTERVAL_TURNS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_USAGE_DECAY_INTERVAL_TURNS ||
      envConfig.MEMORY_USAGE_DECAY_INTERVAL_TURNS ||
      '20',
    10,
  ) || 20,
);
export const MEMORY_CONSOLIDATION_MIN_ITEMS = Math.max(
  2,
  parseInt(
    process.env.MEMORY_CONSOLIDATION_MIN_ITEMS ||
      envConfig.MEMORY_CONSOLIDATION_MIN_ITEMS ||
      '20',
    10,
  ) || 20,
);
export const MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD ||
        envConfig.MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD ||
        '0.8',
    ) || 0.8,
  ),
);