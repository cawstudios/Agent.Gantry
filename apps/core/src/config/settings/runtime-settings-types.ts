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

export type EmbeddingProviderName = string;
export type MemoryModelProfile = 'cheap' | 'balanced' | 'quality';
export type MemoryModelTask = 'extractor' | 'dreaming' | 'consolidation';

export interface RuntimeMemoryLlmModels {
  extractor: string;
  dreaming: string;
  consolidation: string;
}

export interface RuntimeMemorySettings {
  enabled: boolean;
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

export interface RuntimeAgentSettings {
  name: string;
  defaultModel: string;
  oneTimeJobDefaultModel: string;
  recurringJobDefaultModel: string;
  sessions: {
    memoryItemLimit: number;
    maxMemoryContextChars: number;
  };
}

export interface RuntimeConfiguredAgentDmAccessEntry {
  provider: string;
  userIds: string[];
  adminUserId?: string;
}

export interface RuntimeConfiguredAgentBinding {
  jid: string;
  provider?: string;
  name?: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  isMain: boolean;
  model?: string;
}

export interface RuntimeConfiguredAgentCapabilities {
  toolIds: string[];
  skillIds: string[];
  mcpServerIds: string[];
}

export interface RuntimeConfiguredAgent {
  name: string;
  folder: string;
  model?: string;
  oneTimeJobDefaultModel?: string;
  recurringJobDefaultModel?: string;
  bindings: Record<string, RuntimeConfiguredAgentBinding>;
  dmAccess: RuntimeConfiguredAgentDmAccessEntry[];
  capabilities: RuntimeConfiguredAgentCapabilities;
}

export interface RuntimeDesiredStateSettings {
  authoritative: boolean;
}

export type RuntimeCredentialBrokerMode = 'none' | 'onecli' | 'external';

export interface RuntimeCredentialBrokerSettings {
  mode: RuntimeCredentialBrokerMode;
  onecli: {
    url: string;
    postgres: {
      urlEnv: string;
      schema: string;
    };
  };
  external: {
    baseUrl: string;
  };
}

export type { RuntimeMemorySettingsSnapshot, RuntimeStorageSettingsSnapshot };

export interface RuntimeSettings {
  desiredState: RuntimeDesiredStateSettings;
  channels: Record<string, RuntimeChannelSettings>;
  agents: Record<string, RuntimeConfiguredAgent>;
  storage: RuntimeStorageSettings;
  agent: RuntimeAgentSettings;
  credentialBroker: RuntimeCredentialBrokerSettings;
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
