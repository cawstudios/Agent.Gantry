import type { RuntimeDeploymentMode } from './runtime-deployment-mode.js';
import type { AgentPersona } from './agent-persona.js';
import type { AgentRelationshipMode } from './agent-relationship-mode.js';
import type { YoloModeSettings } from './yolo-mode-policy.js';
import type { EgressSettings } from './egress-policy.js';
import type { AgentHarness } from './agent-engine.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { PermissionMode } from './permission-mode.js';
import type { ModelWorkload } from './model-catalog.js';
import type { ModelEffortLevel } from './model-catalog.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface RuntimeMemorySettingsSnapshot {
  enabled?: boolean;
  embeddingsEnabled?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  dailyEmbedLimit?: number;
  embedBatchSize?: number;
  backfillEnabled?: boolean;
  backfillCron?: string;
  backfillMaxItemsPerRun?: number;
  backfillMode?: string;
  backfillProviderBatchMinItems?: number;
  dreamingEnabled?: boolean;
  dreamingCron?: string;
  dreamingAlerts?: boolean;
  dreamingEmbeddingsEnabled?: boolean;
  dreamingEmbeddingProvider?: string;
  dreamingEmbeddingModel?: string;
  llmExtractorModel?: string;
  llmDreamingModel?: string;
  llmConsolidationModel?: string;
  extractorMaxFacts?: number;
  extractorMinConfidence?: number;
  maintenanceMaxPending?: number;
}

export interface RuntimeStorageSettingsSnapshot {
  postgresUrlEnv?: string;
  postgresSchema?: string;
}

export interface RuntimeProviderSettings {
  enabled: boolean;
}

export interface RuntimeProviderAccountSettings {
  agentId: string;
  provider: string;
  label: string;
  status?: 'active' | 'disabled';
  runtimeSecretRefs: Record<string, string>;
  externalIdentityRef?: Record<string, string>;
  config?: Record<string, string>;
}

export type RuntimeConversationKind =
  | 'dm'
  | 'direct'
  | 'group'
  | 'channel'
  | 'chat'
  | 'service'
  | 'web';

export interface RuntimeConfiguredConversation {
  providerAccount: string;
  externalId: string;
  kind: RuntimeConversationKind;
  displayName: string;
  brainHarvest?: boolean;
  requiresTrigger: boolean;
  senderPolicy: ChatAllowlistEntry;
  controlApprovers: string[];
  installedAgents: Record<string, RuntimeConfiguredConversationInstall>;
}

export interface RuntimeConfiguredConversationInstall {
  agentId: string;
  providerAccountId: string;
  threadId?: string;
  status: 'active' | 'disabled';
  addedAt: string;
  memoryScope: 'conversation' | 'user' | 'agent' | 'app';
  model?: string;
  permissionMode?: PermissionMode;
}

export type EmbeddingProviderName = string;
export type MemoryModelTask = 'extractor' | 'dreaming' | 'consolidation';
export type MemoryBackfillMode = 'auto' | 'inline' | 'provider_batch';

export interface RuntimeMemoryLlmModels {
  extractor: string;
  dreaming: string;
  consolidation: string;
}

export interface RuntimeMemoryBackfillSettings {
  enabled: boolean;
  cron: string;
  maxItemsPerRun: number;
  mode: MemoryBackfillMode;
  providerBatchMinItems: number;
}

export interface RuntimeMemorySettings {
  enabled: boolean;
  embeddings: {
    enabled: boolean;
    provider: EmbeddingProviderName;
    model: string;
    dimensions: number;
    dailyLimit: number;
    batchSize: number;
    backfill: RuntimeMemoryBackfillSettings;
  };
  dreaming: {
    enabled: boolean;
    cron: string;
    alerts: boolean;
    embeddings: {
      enabled: boolean;
      provider: EmbeddingProviderName;
      model: string;
    };
  };
  llm: {
    models: RuntimeMemoryLlmModels;
    extractorMaxFacts: number;
    extractorMinConfidence: number;
  };
  maintenance: {
    maxPending: number;
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
  agentHarness: AgentHarness;
  oneTimeJobDefaultModel: string;
  recurringJobDefaultModel: string;
  sessions: {
    memoryItemLimit: number;
    maxMemoryContextChars: number;
  };
}

export interface RuntimeConfiguredAgentSourceRef {
  name?: string;
  id: string;
  version?: string;
  kind?: 'builtin' | 'skill' | 'mcp' | 'adapter' | 'local_cli';
  // Per-agent MCP operation scope (subset of the server's reviewed tool
  // patterns). Only meaningful for `mcp_servers` source refs; empty/absent means
  // the agent inherits the server's full reviewed tool set.
  tools?: string[];
}

export interface RuntimeConfiguredAgentSources {
  skills: RuntimeConfiguredAgentSourceRef[];
  mcpServers: RuntimeConfiguredAgentSourceRef[];
  tools: RuntimeConfiguredAgentSourceRef[];
}

export interface RuntimeConfiguredAgentCapability {
  id: string;
  version: string;
}

export type AgentAccessPreset = 'full' | 'locked';
export type AgentEffort = ModelEffortLevel;
export type RuntimeAgentThinking =
  | { mode: 'off'; budgetTokens?: never }
  | { mode: 'on'; budgetTokens?: number };
export type RuntimeConfiguredToolRule =
  | {
      tool: string;
      when?: { arg: string; matches: string };
      action: 'block';
      reason: string;
    }
  | {
      tool: string;
      action: 'require_prior';
      prior: string;
      reason: string;
    };
export type { AgentRuntime };

export interface RuntimeConfiguredAgent {
  name: string;
  folder: string;
  delegates: string[];
  runtime?: AgentRuntime;
  maxTurns?: number;
  maxRunTokens?: number;
  effort?: AgentEffort;
  thinking?: RuntimeAgentThinking;
  maxOutputTokens?: number;
  persona?: AgentPersona;
  relationshipMode?: AgentRelationshipMode;
  model?: string;
  agentHarness?: AgentHarness;
  permissionMode?: PermissionMode;
  oneTimeJobDefaultModel?: string;
  recurringJobDefaultModel?: string;
  toolRules?: RuntimeConfiguredToolRule[];
  sources: RuntimeConfiguredAgentSources;
  capabilities: RuntimeConfiguredAgentCapability[];
  accessPreset: AgentAccessPreset;
}

export interface RuntimeDesiredStateSettings {
  authoritative: boolean;
}

export type RuntimeCredentialBrokerMode = 'none' | 'gantry';

export interface RuntimeCredentialBrokerSettings {
  mode: RuntimeCredentialBrokerMode;
  gateway: {
    bindHost: string;
  };
}

export interface RuntimeQueueSettings {
  maxMessageRuns: number;
  maxJobRuns: number;
  maxMessageBacklog: number;
  maxTaskBacklog: number;
  maxRetries: number;
  baseRetryMs: number;
  drainDeadlineMs: number;
}

export interface RuntimeLiveTurnsSettings {
  enabled: boolean;
}

export type RuntimeSandboxProvider = 'direct' | 'sandbox_runtime';

export interface RuntimeSandboxSettings {
  provider: RuntimeSandboxProvider;
  resourceLimits: {
    cpuSeconds: number;
    memoryMb: number;
    maxProcesses: number;
  };
}

export type RuntimeArtifactStoreDriver = 'local' | 's3';

export interface RuntimeArtifactStoreSettings {
  driver: RuntimeArtifactStoreDriver;
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface RuntimeProcessSettings {
  queue: RuntimeQueueSettings;
  liveTurns: RuntimeLiveTurnsSettings;
  sandbox: RuntimeSandboxSettings;
  artifactStore: RuntimeArtifactStoreSettings;
  deploymentMode: RuntimeDeploymentMode;
}

export type RuntimeBrowserUsagePolicyMode = 'audit' | 'enforce';

export interface RuntimeBrowserUsageOverride {
  mode?: RuntimeBrowserUsagePolicyMode;
  windowMs?: number;
  maxActionsPerWindow?: number;
  maxConcurrentPerSite?: number;
}

export interface RuntimeBrowserUsageSettings {
  enabled: boolean;
  mode: RuntimeBrowserUsagePolicyMode;
  windowMs: number;
  maxActionsPerWindow: number;
  maxConcurrentPerSite: number;
  overrides: Record<string, RuntimeBrowserUsageOverride>;
}

export interface RuntimeBrowserSettings {
  usage: RuntimeBrowserUsageSettings;
}

export interface RuntimePermissionSettings {
  yoloMode: YoloModeSettings;
  egress: EgressSettings;
  autoMode: {
    model?: string;
  };
}

// Optional in-memory per-provider request rate caps enforced at the model
// gateway. Maps a model provider id (validated against the executable provider
// registry) to a requests-per-minute cap for that provider, per app.
// Absent/empty -> no caps (no behavior change). This is desired-state config
// stored in settings revisions and rendered into settings.yaml; no spend ledger.
export interface RuntimeProviderLimit {
  requestsPerMinute: number;
}

export interface RuntimeLimitSettings {
  providers: Record<string, RuntimeProviderLimit>;
}

export interface RuntimeObservabilitySettings {
  tracing: {
    enabled: boolean;
    endpoint: string;
    captureContent: boolean;
    sampleRate: number;
    environment?: string;
  };
}

export interface RuntimeCustomModelAliasSource {
  label: string;
  url: string;
  verifiedAt: string;
}

export interface RuntimeCustomModelAlias {
  provider: string;
  providerModelId: string;
  displayName: string;
  aliases: string[];
  recommendedAlias: string;
  supportedWorkloads: ModelWorkload[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  cachedInputUsdPerMillionTokens?: number;
  cacheWriteUsdPerMillionTokens?: number;
  supportsThinking?: boolean;
  supportsTools?: boolean;
  source: RuntimeCustomModelAliasSource;
}

export interface RuntimeSettings {
  desiredState: RuntimeDesiredStateSettings;
  providers: Record<string, RuntimeProviderSettings>;
  providerAccounts: Record<string, RuntimeProviderAccountSettings>;
  conversations: Record<string, RuntimeConfiguredConversation>;
  agents: Record<string, RuntimeConfiguredAgent>;
  storage: RuntimeStorageSettings;
  agent: RuntimeAgentSettings;
  credentialBroker: RuntimeCredentialBrokerSettings;
  memory: RuntimeMemorySettings;
  runtime: RuntimeProcessSettings;
  browser: RuntimeBrowserSettings;
  permissions: RuntimePermissionSettings;
  // Optional in-memory per-provider request rate caps (settings.yaml `limits`).
  // Absent/empty -> no caps. Restart-owned; no DB projection.
  limits: RuntimeLimitSettings;
  observability: RuntimeObservabilitySettings;
  // Optional per-family member-order override for model families. Maps a family
  // alias to a list of member aliases OR provider ids in preference order;
  // absent/empty -> the hardcoded MODEL_FAMILIES order. Unknown tokens are
  // ignored at resolve time.
  modelFamilies: Record<string, string[]>;
  // Optional settings-owned aliases for models exposed by existing providers.
  // Values are non-secret metadata; provider credentials stay in Model Access.
  modelAliases: Record<string, RuntimeCustomModelAlias>;
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
