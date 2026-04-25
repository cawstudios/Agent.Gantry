import { envConfig } from './env/index.js';
import { runtimeMemorySettings } from './memory-state.js';

export const RUNTIME_MEMORY_DREAMING_ENABLED =
  runtimeMemorySettings.dreamingEnabled ?? false;

export const MEMORY_DREAMING_CRON =
  process.env.MEMORY_DREAMING_CRON ||
  envConfig.MEMORY_DREAMING_CRON ||
  '15 3 * * *';

export const MEMORY_EMBED_BATCH_SIZE = Math.max(
  1,
  parseInt(
    process.env.MEMORY_EMBED_BATCH_SIZE ||
      envConfig.MEMORY_EMBED_BATCH_SIZE ||
      '16',
    10,
  ) || 16,
);

export const MEMORY_MAINTENANCE_MAX_PENDING = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAINTENANCE_MAX_PENDING ||
      envConfig.MEMORY_MAINTENANCE_MAX_PENDING ||
      '5000',
    10,
  ) || 5000,
);
