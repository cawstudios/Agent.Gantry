import {
  MEMORY_MODEL_DEFAULTS,
  normalizeClaudeModelSelection,
} from '../models/claude-model-registry.js';
import { envConfig } from './env/index.js';
import { parseBooleanEnv } from './env/parse.js';
import { runtimeMemorySettings } from './memory-state.js';

export const RUNTIME_MEMORY_DREAMING_ENABLED =
  runtimeMemorySettings.dreamingEnabled ?? false;
export const MEMORY_DREAMING_CRON =
  process.env.MEMORY_DREAMING_CRON ||
  envConfig.MEMORY_DREAMING_CRON ||
  '0 3 * * *';
export const MEMORY_DREAMING_DRY_RUN = parseBooleanEnv(
  process.env.MEMORY_DREAMING_DRY_RUN || envConfig.MEMORY_DREAMING_DRY_RUN,
  true,
);
export const MEMORY_DREAMING_PROMOTION_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_PROMOTION_THRESHOLD ||
        envConfig.MEMORY_DREAMING_PROMOTION_THRESHOLD ||
        '0.55',
    ) || 0.55,
  ),
);
export const MEMORY_DREAMING_DECAY_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_DECAY_THRESHOLD ||
        envConfig.MEMORY_DREAMING_DECAY_THRESHOLD ||
        '0.15',
    ) || 0.15,
  ),
);
export const MEMORY_DREAMING_MIN_RECALLS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_DREAMING_MIN_RECALLS ||
      envConfig.MEMORY_DREAMING_MIN_RECALLS ||
      '3',
    10,
  ) || 3,
);
export const MEMORY_DREAMING_MIN_UNIQUE_QUERIES = Math.max(
  1,
  parseInt(
    process.env.MEMORY_DREAMING_MIN_UNIQUE_QUERIES ||
      envConfig.MEMORY_DREAMING_MIN_UNIQUE_QUERIES ||
      '2',
    10,
  ) || 2,
);
export const MEMORY_DREAMING_CONFIDENCE_BOOST = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_CONFIDENCE_BOOST ||
        envConfig.MEMORY_DREAMING_CONFIDENCE_BOOST ||
        '0.05',
    ) || 0.05,
  ),
);
export const MEMORY_DREAMING_CONFIDENCE_DECAY = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_CONFIDENCE_DECAY ||
        envConfig.MEMORY_DREAMING_CONFIDENCE_DECAY ||
        '0.03',
    ) || 0.03,
  ),
);
export const MEMORY_EMBED_BATCH_SIZE = Math.max(
  1,
  parseInt(
    process.env.MEMORY_EMBED_BATCH_SIZE ||
      envConfig.MEMORY_EMBED_BATCH_SIZE ||
      '16',
    10,
  ) || 16,
);
export const MEMORY_VECTOR_DIMENSIONS = Math.max(
  128,
  parseInt(
    process.env.MEMORY_VECTOR_DIMENSIONS ||
      envConfig.MEMORY_VECTOR_DIMENSIONS ||
      '3072',
    10,
  ) || 3072,
);
export const MEMORY_MAX_CHUNKS_PER_GROUP = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAX_CHUNKS_PER_GROUP ||
      envConfig.MEMORY_MAX_CHUNKS_PER_GROUP ||
      '6000',
    10,
  ) || 6000,
);
export const MEMORY_CHUNK_RETENTION_DAYS = Math.max(
  7,
  parseInt(
    process.env.MEMORY_CHUNK_RETENTION_DAYS ||
      envConfig.MEMORY_CHUNK_RETENTION_DAYS ||
      '120',
    10,
  ) || 120,
);
export const MEMORY_MAX_EVENTS = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAX_EVENTS || envConfig.MEMORY_MAX_EVENTS || '20000',
    10,
  ) || 20000,
);
export const MEMORY_MAX_PROCEDURES_PER_GROUP = Math.max(
  20,
  parseInt(
    process.env.MEMORY_MAX_PROCEDURES_PER_GROUP ||
      envConfig.MEMORY_MAX_PROCEDURES_PER_GROUP ||
      '500',
    10,
  ) || 500,
);
export const MEMORY_CONSOLIDATION_MAX_CLUSTERS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_CONSOLIDATION_MAX_CLUSTERS ||
      envConfig.MEMORY_CONSOLIDATION_MAX_CLUSTERS ||
      '10',
    10,
  ) || 10,
);
export const MEMORY_CONSOLIDATION_EMBEDDING_FALLBACK = parseBooleanEnv(
  process.env.MEMORY_CONSOLIDATION_EMBEDDING_FALLBACK ||
    envConfig.MEMORY_CONSOLIDATION_EMBEDDING_FALLBACK,
  true,
);

function resolveMemoryLlmModel(
  taskModel: string | undefined,
  defaultModel: string,
  anthropicModel: string | undefined,
): string {
  return (
    normalizeClaudeModelSelection(taskModel) || anthropicModel || defaultModel
  );
}

export function getMemoryModelConfig(anthropicModel: string | undefined): {
  extractor: string;
  dreaming: string;
  consolidation: string;
} {
  return {
    extractor: resolveMemoryLlmModel(
      runtimeMemorySettings.llmExtractorModel,
      MEMORY_MODEL_DEFAULTS.extractor,
      anthropicModel,
    ),
    dreaming: resolveMemoryLlmModel(
      runtimeMemorySettings.llmDreamingModel,
      MEMORY_MODEL_DEFAULTS.dreaming,
      anthropicModel,
    ),
    consolidation: resolveMemoryLlmModel(
      runtimeMemorySettings.llmConsolidationModel,
      MEMORY_MODEL_DEFAULTS.consolidation,
      anthropicModel,
    ),
  };
}

export const MEMORY_CLEANUP_PURGE_DAYS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_CLEANUP_PURGE_DAYS ||
      envConfig.MEMORY_CLEANUP_PURGE_DAYS ||
      '30',
    10,
  ) || 30,
);
export const MEMORY_JOURNAL_GZIP_DAYS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_JOURNAL_GZIP_DAYS ||
      envConfig.MEMORY_JOURNAL_GZIP_DAYS ||
      '7',
    10,
  ) || 7,
);
export const MEMORY_JOURNAL_DELETE_DAYS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_JOURNAL_DELETE_DAYS ||
      envConfig.MEMORY_JOURNAL_DELETE_DAYS ||
      '90',
    10,
  ) || 90,
);
export function isMemoryJournalDisabled(): boolean {
  return parseBooleanEnv(
    process.env.MYCLAW_MEMORY_JOURNAL_DISABLED ||
      envConfig.MYCLAW_MEMORY_JOURNAL_DISABLED,
    false,
  );
}

export const MEMORY_JOURNAL_DISABLED = isMemoryJournalDisabled();
export const MEMORY_MAINTENANCE_MAX_PENDING = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAINTENANCE_MAX_PENDING ||
      envConfig.MEMORY_MAINTENANCE_MAX_PENDING ||
      '5000',
    10,
  ) || 5000,
);
export const MEMORY_BRIEF_INCLUDE_LAST_SESSION = parseBooleanEnv(
  process.env.MEMORY_BRIEF_INCLUDE_LAST_SESSION ||
    envConfig.MEMORY_BRIEF_INCLUDE_LAST_SESSION,
  true,
);
export const MEMORY_BRIEF_DIRTY_REFRESH = parseBooleanEnv(
  process.env.MEMORY_BRIEF_DIRTY_REFRESH ||
    envConfig.MEMORY_BRIEF_DIRTY_REFRESH,
  true,
);