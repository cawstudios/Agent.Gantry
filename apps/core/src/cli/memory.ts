import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import {
  DisabledEmbeddingClient,
  OpenAIEmbeddingClient,
  type EmbeddingProvider,
} from '../memory/memory-embeddings.js';
import { CachedEmbeddingProvider } from '../memory/memory-embedding-cache.js';
import { MemoryIndexer } from '../memory/memory-indexer.js';
import { MemoryService } from '../memory/memory-service.js';
import { MemoryStore } from '../memory/persistence/store.js';

import { readEnvFile } from '../config/env/file.js';
import {
  collectMemoryStatus,
  formatMemoryStatusExtras,
} from './memory-status.js';
import {
  inspectMemoryHealth,
  inspectMemoryJournalStatus,
} from './memory-health.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import {
  closeRuntimeStorage,
  initializeRuntimeStorage,
} from '../infrastructure/postgres/runtime-store.js';
import {
  applyMemoryModelProfile,
  getMemoryModelProfileDefaults,
  type MemoryModelProfile,
  type MemoryModelTask,
  loadRuntimeSettings,
  saveRuntimeSettings,
  type EmbeddingProviderName,
  type RuntimeSettings,
} from '../config/settings/runtime-settings.js';

function usage(): string {
  return [
    'Usage:',
    '  myclaw memory status [--json]',
    '  myclaw memory reindex',
    '  myclaw memory embeddings <off|disabled|openai>',
    '  myclaw memory dreaming <on|off>',
    '  myclaw memory health journal-status',
    '  myclaw memory counters',
    '  myclaw memory model set <extractor|dreaming|consolidation> <model>',
    '  myclaw memory model profile <cheap|balanced|quality>',
  ].join('\n');
}

interface EffectiveModelRow {
  model: string;
  source: 'settings.yaml' | 'ANTHROPIC_MODEL' | 'default';
}

function safeRealpathSync(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function resolveEffectiveModel(
  configuredModel: string | undefined,
  globalModel: string | undefined,
  hardDefault: string,
): EffectiveModelRow {
  const configured = configuredModel?.trim();
  if (configured) {
    return { model: configured, source: 'settings.yaml' };
  }
  const global = globalModel?.trim();
  if (global) {
    return { model: global, source: 'ANTHROPIC_MODEL' };
  }
  return { model: hardDefault, source: 'default' };
}

function formatMemoryStatus(runtimeHome: string): string {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  const globalModel = env.ANTHROPIC_MODEL;
  const hardDefaults = getMemoryModelProfileDefaults('balanced');
  const extractorModel = resolveEffectiveModel(
    settings.memory.llm.models.extractor,
    globalModel,
    hardDefaults.extractor,
  );
  const dreamingModel = resolveEffectiveModel(
    settings.memory.llm.models.dreaming,
    globalModel,
    hardDefaults.dreaming,
  );
  const consolidationModel = resolveEffectiveModel(
    settings.memory.llm.models.consolidation,
    globalModel,
    hardDefaults.consolidation,
  );
  const onecliUrl = env.ONECLI_URL?.trim() || '';
  return [
    'MyClaw Memory',
    '',
    `Memory: ${health.memoryEnabled ? 'on' : 'off'} (source: ${health.memorySource})`,
    `Storage: ${health.memoryCheck.status}`,
    `Memory root: ${health.memoryRoot} (source: ${health.memoryRootSource})`,
    `Storage backend: ${health.storageProvider} (source: settings.yaml)`,
    'Memory tables: Postgres runtime schema',
    `Embeddings: ${health.embeddingsEnabled ? 'on' : 'off'}`,
    `Embedding provider: ${health.embeddingProvider} (${health.embeddingCheck.status}, source: ${health.embeddingProviderSource})`,
    `Embedding model: ${health.embeddingModel} (source: ${health.embeddingModelSource})`,
    `Dreaming: ${health.dreamingEnabled ? 'on' : 'off'} (source: ${health.dreamingSource})`,
    `Claude broker: ${onecliUrl ? 'configured' : 'missing'} (ONECLI_URL)`,
    `Model extractor: ${extractorModel.model} (source: ${extractorModel.source})`,
    `Model dreaming: ${dreamingModel.model} (source: ${dreamingModel.source})`,
    `Model consolidation: ${consolidationModel.model} (source: ${consolidationModel.source})`,
  ].join('\n');
}

function formatJournalStatus(runtimeHome: string): string {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const report = inspectMemoryJournalStatus(runtimeHome, settings);
  const lines = [
    'Memory Journal Status',
    '',
    `Root: ${report.journalRoot}`,
    '',
  ];
  if (report.groups.length === 0) {
    lines.push('No journal groups found.');
    return lines.join('\n');
  }
  for (const group of report.groups) {
    lines.push(
      `${group.groupFolder}: files=${group.fileCount} bytes=${group.totalBytes} last_event=${group.lastEventAt || 'never'}${group.stale ? ' stale>24h' : ''}${group.oversized ? ' oversized>200MB' : ''}`,
    );
  }
  return lines.join('\n');
}

function setEmbeddings(
  runtimeHome: string,
  provider: EmbeddingProviderName,
): { ok: boolean; message?: string } {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  if (provider === 'openai' && !env.OPENAI_API_KEY?.trim()) {
    return {
      ok: false,
      message:
        'OPENAI_API_KEY is required only for OpenAI embeddings. Set it with `myclaw config set OPENAI_API_KEY <key>` or run `myclaw memory embeddings off`.',
    };
  }
  settings.memory.embeddings.enabled = provider === 'openai';
  settings.memory.embeddings.provider = provider;
  if (!settings.memory.embeddings.model.trim()) {
    settings.memory.embeddings.model = 'text-embedding-3-large';
  }
  saveRuntimeSettings(runtimeHome, settings);
  return { ok: true };
}

function setDreaming(runtimeHome: string, enabled: boolean): void {
  const settings = loadRuntimeSettings(runtimeHome);
  settings.memory.dreaming.enabled = enabled;
  if (enabled && !settings.memory.enabled) settings.memory.enabled = true;
  saveRuntimeSettings(runtimeHome, settings);
}

function parseModelTask(raw: string | undefined): MemoryModelTask | null {
  if (!raw) return null;
  const normalized = raw.trim();
  if (normalized === 'extractor') return 'extractor';
  if (normalized === 'dreaming') return 'dreaming';
  if (normalized === 'consolidation') return 'consolidation';
  return null;
}

function setTaskModel(
  runtimeHome: string,
  task: MemoryModelTask,
  model: string,
): { ok: boolean; message?: string } {
  const trimmed = model.trim();
  if (!trimmed) {
    return { ok: false, message: 'Model must be a non-empty string.' };
  }
  const settings = loadRuntimeSettings(runtimeHome);
  settings.memory.llm.models[task] = trimmed;
  saveRuntimeSettings(runtimeHome, settings);
  return { ok: true };
}

function setModelProfile(
  runtimeHome: string,
  profile: MemoryModelProfile,
): void {
  const settings = loadRuntimeSettings(runtimeHome);
  applyMemoryModelProfile(settings, profile);
  saveRuntimeSettings(runtimeHome, settings);
}

function resolveMemoryRoot(
  runtimeHome: string,
  settingsOverride?: RuntimeSettings,
): string {
  const settings = settingsOverride || loadRuntimeSettings(runtimeHome);
  const raw = settings.memory.root?.trim() || 'memory';
  return path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(runtimeHome, raw);
}

function resolvePathWithRealParent(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);
  const direct = safeRealpathSync(resolved);
  if (direct) return direct;
  let existingParent = path.dirname(resolved);
  while (!fs.existsSync(existingParent)) {
    const parent = path.dirname(existingParent);
    if (parent === existingParent) break;
    existingParent = parent;
  }
  const parentReal = safeRealpathSync(existingParent);
  if (!parentReal) return null;
  const tail = path.relative(existingParent, resolved);
  return path.resolve(parentReal, tail);
}

function assertPathInsideRuntimeHome(
  runtimeHome: string,
  targetPath: string,
  description: string,
): string {
  const runtimeReal = safeRealpathSync(path.resolve(runtimeHome));
  if (!runtimeReal) {
    throw new Error(
      `Refusing reindex: runtime home must resolve to an existing path (${runtimeHome}).`,
    );
  }
  const canonicalTarget = resolvePathWithRealParent(targetPath);
  if (!canonicalTarget) {
    throw new Error(
      `Refusing reindex: ${description} must resolve to an existing parent path.`,
    );
  }
  const relative = path.relative(runtimeReal, canonicalTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing reindex: ${description} must resolve inside runtime home (${runtimeReal}).`,
    );
  }
  return canonicalTarget;
}

function createReindexEmbeddingProvider(
  settings: RuntimeSettings,
  env: Record<string, string | undefined>,
): EmbeddingProvider {
  if (
    !settings.memory.embeddings.enabled ||
    settings.memory.embeddings.provider === 'disabled'
  ) {
    return new DisabledEmbeddingClient();
  }
  if (settings.memory.embeddings.provider !== 'openai') {
    throw new Error(
      `Unknown embedding provider "${settings.memory.embeddings.provider}"`,
    );
  }
  const apiKey = env.OPENAI_API_KEY?.trim() || null;
  return new OpenAIEmbeddingClient(apiKey, settings.memory.embeddings.model);
}

async function runScopedReindex(input: {
  memoryRoot: string;
  settings: RuntimeSettings;
  env: Record<string, string | undefined>;
}): Promise<{ scanned: number; reindexed: number }> {
  await initializeRuntimeStorage();
  const store = new MemoryStore();
  try {
    const baseProvider = createReindexEmbeddingProvider(
      input.settings,
      input.env,
    );
    const embeddings = new CachedEmbeddingProvider(baseProvider, store);
    embeddings.validateConfiguration();
    const indexer = new MemoryIndexer(input.memoryRoot, store, embeddings);
    return await indexer.reindexStaleFilesAndWait();
  } finally {
    store.close();
    await closeRuntimeStorage();
  }
}

function parseOption(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] || '';
    if (arg === `--${name}`) return args[i + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

export async function runMemoryCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, value, extra] = args;

  if (!command || command === 'status') {
    const statusFlags = command ? args.slice(1) : [];
    const jsonMode = statusFlags.includes('--json');
    const snapshot = collectMemoryStatus(runtimeHome);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      return 0;
    }
    p.note(formatMemoryStatus(runtimeHome), 'Memory');
    p.note(formatMemoryStatusExtras(snapshot), 'Memory Runtime');
    return 0;
  }

  if (command === 'embeddings') {
    const normalized = value === 'off' ? 'disabled' : value;
    if (!['disabled', 'openai'].includes(normalized || '')) {
      p.log.error(usage());
      return 1;
    }
    const result = setEmbeddings(
      runtimeHome,
      normalized as EmbeddingProviderName,
    );
    if (!result.ok) {
      p.log.error(result.message || 'Could not update embeddings settings.');
      return 1;
    }
    p.log.success(`Memory embeddings set to ${normalized} in settings.yaml.`);
    return 0;
  }

  if (command === 'dreaming') {
    if (value !== 'on' && value !== 'off') {
      p.log.error(usage());
      return 1;
    }
    setDreaming(runtimeHome, value === 'on');
    p.log.success(`Memory dreaming set to ${value} in settings.yaml.`);
    return 0;
  }

  if (command === 'health') {
    if (value === 'journal-status') {
      p.note(formatJournalStatus(runtimeHome), 'Memory Health');
      return 0;
    }
    p.log.error(usage());
    return 1;
  }

  if (command === 'reindex') {
    if (args.includes('--full')) {
      p.log.error('memory reindex --full is not supported.');
      return 1;
    }
    const settings = loadRuntimeSettings(runtimeHome);
    const env = readEnvFile(envFilePath(runtimeHome));
    const configuredMemoryRoot = resolveMemoryRoot(runtimeHome, settings);
    let safeMemoryRoot: string;
    try {
      safeMemoryRoot = assertPathInsideRuntimeHome(
        runtimeHome,
        configuredMemoryRoot,
        'memory.root',
      );
    } catch (err) {
      p.log.error((err as Error).message);
      return 1;
    }
    let result: { scanned: number; reindexed: number };
    try {
      result = await runScopedReindex({
        memoryRoot: safeMemoryRoot,
        settings,
        env,
      });
    } catch (err) {
      p.log.error(`Reindex failed: ${(err as Error).message}`);
      return 1;
    }
    p.log.success(
      `Reindex complete. scanned=${result.scanned} reindexed=${result.reindexed}`,
    );
    return 0;
  }

  if (command === 'model') {
    if (value === 'set') {
      const task = parseModelTask(args[2]);
      const model = args[3] || '';
      if (!task || !model.trim()) {
        p.log.error(usage());
        return 1;
      }
      const result = setTaskModel(runtimeHome, task, model);
      if (!result.ok) {
        p.log.error(result.message || 'Could not update model setting.');
        return 1;
      }
      p.log.success(
        `Memory model for ${task} set to ${model.trim()} in settings.yaml.`,
      );
      return 0;
    }

    if (value === 'profile') {
      const profile = extra as MemoryModelProfile | undefined;
      if (!profile || !['cheap', 'balanced', 'quality'].includes(profile)) {
        p.log.error(usage());
        return 1;
      }
      setModelProfile(runtimeHome, profile);
      p.log.success(`Memory model profile set to ${profile} in settings.yaml.`);
      return 0;
    }

    p.log.error(usage());
    return 1;
  }

  if (command === 'counters') {
    const counters = MemoryService.getCountersSnapshot();
    p.note(
      Object.entries(counters)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n'),
      'Memory Counters',
    );
    return 0;
  }

  p.log.error(usage());
  return 1;
}