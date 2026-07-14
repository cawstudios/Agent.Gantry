import { migrateLegacyAgentBindings } from './settings-revision-legacy-bindings.js';

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function parseOptionalRecord(
  raw: unknown,
  pathPrefix: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${pathPrefix} must be a mapping`);
  return raw;
}

function assertSupportedKeys(
  map: Record<string, unknown>,
  pathPrefix: string,
  supported: Set<string>,
  extraAllowed?: (key: string) => boolean,
): void {
  for (const key of Object.keys(map)) {
    if (!supported.has(key) && !extraAllowed?.(key)) {
      throw new Error(`${pathPrefix}.${key} is not supported`);
    }
  }
}

const STORED_REVISION_KEY_ALIASES = new Map<string, string>([
  ['addedAt', 'added_at'],
  ['agentHarness', 'agent_harness'],
  ['accessPreset', 'access_preset'],
  ['artifactStore', 'artifact_store'],
  ['baseRetryMs', 'base_retry_ms'],
  ['batchSize', 'batch_size'],
  ['bindHost', 'bind_host'],
  ['brainHarvest', 'brain_harvest'],
  ['controlApprovers', 'control_approvers'],
  ['contextWindowTokens', 'context_window_tokens'],
  ['cpuSeconds', 'cpu_seconds'],
  ['credentialBroker', 'model_access'],
  ['dailyLimit', 'daily_limit'],
  ['defaultModel', 'default_model'],
  ['defaultConnection', 'default_connection'],
  ['denylistPaths', 'denylist_paths'],
  ['desiredState', 'desired_state'],
  ['deploymentMode', 'deployment_mode'],
  ['displayName', 'display_name'],
  ['drainDeadlineMs', 'drain_deadline_ms'],
  ['externalId', 'external_id'],
  ['extractorMaxFacts', 'extractor_max_facts'],
  ['extractorMinConfidence', 'extractor_min_confidence'],
  ['forcePathStyle', 'force_path_style'],
  ['inputUsdPerMillionTokens', 'input_usd_per_million_tokens'],
  ['installedAgents', 'installed_agents'],
  ['liveTurns', 'live_turns'],
  ['maxActionsPerWindow', 'max_actions_per_window'],
  ['maxConcurrentPerSite', 'max_concurrent_per_site'],
  ['maxItemsPerRun', 'max_items_per_run'],
  ['maxJobRuns', 'max_job_runs'],
  ['maxMemoryContextChars', 'max_memory_context_chars'],
  ['maxMessageBacklog', 'max_message_backlog'],
  ['maxMessageRuns', 'max_message_runs'],
  ['maxOutputTokens', 'max_output_tokens'],
  ['maxPending', 'max_pending'],
  ['maxProcesses', 'max_processes'],
  ['maxRetries', 'max_retries'],
  ['maxTaskBacklog', 'max_task_backlog'],
  ['memoryItemLimit', 'memory_item_limit'],
  ['memoryMb', 'memory_mb'],
  ['memoryScope', 'memory_scope'],
  ['mcpServers', 'mcp_servers'],
  ['modelAccess', 'model_access'],
  ['modelAliases', 'model_aliases'],
  ['modelFamilies', 'model_families'],
  ['oneTimeJobDefaultModel', 'one_time_job_default_model'],
  ['outputUsdPerMillionTokens', 'output_usd_per_million_tokens'],
  ['providerAccount', 'provider_account'],
  ['providerAccounts', 'provider_accounts'],
  ['providerConnection', 'provider_connection'],
  ['providerConnections', 'provider_connections'],
  ['providerBatchMinItems', 'provider_batch_min_items'],
  ['providerModelId', 'provider_model_id'],
  ['recurringJobDefaultModel', 'recurring_job_default_model'],
  ['recommendedAlias', 'recommended_alias'],
  ['relationshipMode', 'relationship_mode'],
  ['requestsPerMinute', 'requests_per_minute'],
  ['requiresTrigger', 'requires_trigger'],
  ['resourceLimits', 'resource_limits'],
  ['runtimeSecretRefs', 'runtime_secret_refs'],
  ['senderPolicy', 'sender_policy'],
  ['supportedWorkloads', 'supported_workloads'],
  ['supportsThinking', 'supports_thinking'],
  ['supportsTools', 'supports_tools'],
  ['urlEnv', 'url_env'],
  ['verifiedAt', 'verified_at'],
  ['windowMs', 'window_ms'],
  ['yoloMode', 'yolo_mode'],
]);

function normalizeStoredRevisionAliases(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStoredRevisionAliases);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, rawItem] of Object.entries(value)) {
    const normalizedKey = STORED_REVISION_KEY_ALIASES.get(key) ?? key;
    if (normalized[normalizedKey] !== undefined && normalizedKey !== key) {
      continue;
    }
    normalized[normalizedKey] = normalizeStoredRevisionAliases(rawItem);
  }
  return normalized;
}

function normalizeCompactDefaults(
  normalized: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (root.defaults !== undefined && !isRecord(root.defaults)) {
    throw new Error('defaults must be a mapping');
  }

  if (!isRecord(root.defaults)) return;
  const defaults = root.defaults;
  for (const key of Object.keys(defaults)) {
    if (
      key !== 'name' &&
      key !== 'model' &&
      key !== 'agent_harness' &&
      key !== 'jobs' &&
      key !== 'sessions'
    ) {
      throw new Error(
        `defaults.${key} is not supported. Configure defaults.name, defaults.model, defaults.agent_harness, defaults.jobs.*, or defaults.sessions.*.`,
      );
    }
  }
  const jobs = parseOptionalRecord(defaults.jobs, 'defaults.jobs') || {};
  for (const key of Object.keys(jobs)) {
    if (
      key !== 'one_time_model' &&
      key !== 'recurring_model' &&
      key !== 'one_time_job_default_model' &&
      key !== 'recurring_job_default_model'
    ) {
      throw new Error(
        `defaults.jobs.${key} is not supported. Configure one_time_model or recurring_model.`,
      );
    }
  }
  const sessions = parseOptionalRecord(defaults.sessions, 'defaults.sessions');
  normalized.agent = {
    name: defaults.name,
    default_model: defaults.model,
    agent_harness: defaults.agent_harness,
    one_time_job_default_model:
      jobs.one_time_model ?? jobs.one_time_job_default_model,
    recurring_job_default_model:
      jobs.recurring_model ?? jobs.recurring_job_default_model,
    sessions,
  };
  delete normalized.defaults;
}

function normalizeCompactProviders(
  normalized: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (!isRecord(root.providers)) return;
  const providers: Record<string, unknown> = {};
  for (const [providerId, providerRaw] of Object.entries(root.providers)) {
    if (!isRecord(providerRaw)) {
      providers[providerId] = providerRaw;
      continue;
    }
    assertSupportedKeys(
      providerRaw,
      `providers.${providerId}`,
      new Set(['enabled']),
    );
    providers[providerId] = { enabled: providerRaw.enabled };
  }
  normalized.providers = providers;
}

function normalizeCompactAgents(
  normalized: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (!isRecord(root.agents)) return;
  const agents: Record<string, unknown> = {};
  for (const [agentId, agentRaw] of Object.entries(root.agents)) {
    if (!isRecord(agentRaw)) {
      agents[agentId] = agentRaw;
      continue;
    }
    const jobs =
      parseOptionalRecord(agentRaw.jobs, `agents.${agentId}.jobs`) || {};
    assertSupportedKeys(
      jobs,
      `agents.${agentId}.jobs`,
      new Set([
        'one_time_model',
        'recurring_model',
        'one_time_job_default_model',
        'recurring_job_default_model',
      ]),
    );
    const { jobs: _jobs, ...verboseAgent } = agentRaw;
    agents[agentId] = {
      ...verboseAgent,
      one_time_job_default_model:
        agentRaw.one_time_job_default_model ??
        jobs.one_time_model ??
        jobs.one_time_job_default_model,
      recurring_job_default_model:
        agentRaw.recurring_job_default_model ??
        jobs.recurring_model ??
        jobs.recurring_job_default_model,
    };
  }
  normalized.agents = agents;
}

function normalizeCompactConversations(
  normalized: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  if (!isRecord(root.conversations)) return;
  const conversations: Record<string, unknown> = {};
  for (const [conversationId, conversationRaw] of Object.entries(
    root.conversations,
  )) {
    if (!isRecord(conversationRaw)) {
      conversations[conversationId] = conversationRaw;
      continue;
    }
    assertSupportedKeys(
      conversationRaw,
      `conversations.${conversationId}`,
      new Set([
        'provider_account',
        'id',
        'external_id',
        'type',
        'kind',
        'display_name',
        'brain_harvest',
        'sender_policy',
        'control_approvers',
        'installed_agents',
      ]),
    );
    conversations[conversationId] = {
      provider_account: conversationRaw.provider_account,
      external_id: conversationRaw.id ?? conversationRaw.external_id,
      kind: conversationRaw.type ?? conversationRaw.kind,
      display_name: conversationRaw.display_name,
      brain_harvest: conversationRaw.brain_harvest,
      sender_policy: conversationRaw.sender_policy,
      control_approvers: conversationRaw.control_approvers,
      installed_agents: conversationRaw.installed_agents,
    };
  }
  normalized.conversations = conversations;
}

export function normalizeCompactRuntimeSettingsRoot(
  root: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedRoot = migrateLegacyAgentBindings(
    normalizeStoredRevisionAliases(root) as Record<string, unknown>,
  );
  for (const key of ['provider_connections', 'bindings']) {
    if (normalizedRoot[key] !== undefined) {
      throw new Error(
        `${key} is no longer supported. Use provider_accounts and conversations.*.installed_agents.`,
      );
    }
  }
  const normalized: Record<string, unknown> = { ...normalizedRoot };
  normalizeCompactDefaults(normalized, normalizedRoot);
  normalizeCompactProviders(normalized, normalizedRoot);
  normalizeCompactAgents(normalized, normalizedRoot);
  normalizeCompactConversations(normalized, normalizedRoot);
  return normalized;
}
