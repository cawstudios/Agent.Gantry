import type {
  RuntimeMemorySettingsSnapshot,
  RuntimeStorageSettingsSnapshot,
} from './memory-snapshot.js';

export type RuntimeChannel = string;

export interface RuntimeChannelSettings {
  enabled: boolean;
  senderAllowlist: import('./sender-allowlist.js').SenderAllowlistConfig;
  controlAllowlist: import('./control-allowlist.js').SenderControlAllowlistConfig;
}

export type EmbeddingProviderName = 'disabled' | 'openai';
export type MemoryModelProfile = 'cheap' | 'balanced' | 'quality';
export type MemoryModelTask = 'extractor' | 'dreaming' | 'consolidation';

export interface RuntimeMemoryLlmModels {
  extractor: string;
  dreaming: string;
  consolidation: string;
}

export interface RuntimeMemorySettings {
  enabled: boolean;
  root: string;
  embeddings: {
    enabled: boolean;
    provider: EmbeddingProviderName;
    model: string;
  };
  dreaming: {
    enabled: boolean;
  };
  llm: {
    models: RuntimeMemoryLlmModels;
  };
}

export interface RuntimeStorageSettings {
  postgres: {
    urlEnv: string;
    schema: string;
  };
}

export type { RuntimeMemorySettingsSnapshot, RuntimeStorageSettingsSnapshot };

export interface RuntimeSettings {
  channels: Record<string, RuntimeChannelSettings>;
  storage: RuntimeStorageSettings;
  memory: RuntimeMemorySettings;
}

export interface RuntimeSettingsValidationFailure {
  summary: string;
  details: string[];
}

export interface RuntimeSettingsValidationResult {
  ok: boolean;
  settings?: RuntimeSettings;
  failure?: RuntimeSettingsValidationFailure;
}