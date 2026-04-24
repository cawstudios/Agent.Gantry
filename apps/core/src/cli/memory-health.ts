import fs from 'fs';
import path from 'path';

import { OpenAIEmbeddingClient } from '../memory/memory-embeddings.js';
import type { RuntimeSettings } from '../config/settings/runtime-settings.js';

export type HealthStatus = 'pass' | 'warn' | 'fail';
export type ConfigSource = 'settings.yaml' | 'default' | 'env' | 'derived';

export interface HealthCheckResult {
  status: HealthStatus;
  message: string;
  nextAction?: string;
}

export interface MemoryHealthInspection {
  storageProvider: 'postgres';
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  embeddingProvider: string;
  memoryRoot: string;
  embeddingModel: string;
  memorySource: ConfigSource;
  memoryRootSource: ConfigSource;
  embeddingProviderSource: ConfigSource;
  embeddingModelSource: ConfigSource;
  dreamingSource: ConfigSource;
  memoryCheck: HealthCheckResult;
  embeddingCheck: HealthCheckResult;
  warnings: HealthCheckResult[];
}

export function resolveRuntimePath(
  runtimeHome: string,
  rawValue: string | undefined,
  fallbackRelativePath: string,
): string {
  const raw = rawValue?.trim();
  if (!raw) return path.resolve(runtimeHome, fallbackRelativePath);
  return path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(runtimeHome, raw);
}

function inspectMemoryStorage(
  memoryEnabled: boolean,
  memoryRoot: string,
): HealthCheckResult {
  if (!memoryEnabled) {
    return {
      status: 'pass',
      message: 'Memory is disabled in settings.yaml.',
    };
  }

  try {
    fs.mkdirSync(memoryRoot, { recursive: true });
    fs.accessSync(memoryRoot, fs.constants.W_OK);
    return {
      status: 'pass',
      message:
        'Memory root is writable; durable memory tables live in Postgres runtime storage.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      message: `Memory storage health check failed at ${memoryRoot}.`,
      nextAction: `Repair memory.root and Postgres runtime storage configuration. Details: ${message}`,
    };
  }
}

function inspectEmbeddings(input: {
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  env: Record<string, string | undefined>;
}): HealthCheckResult {
  if (!input.memoryEnabled) {
    return {
      status: 'pass',
      message: 'Memory is disabled, so embeddings are not required.',
    };
  }

  if (!input.embeddingsEnabled) {
    return {
      status: 'pass',
      message:
        'Embeddings are optional and currently disabled in settings.yaml.',
    };
  }

  if (input.embeddingProvider !== 'openai') {
    return {
      status: 'fail',
      message: `Unknown embedding provider "${input.embeddingProvider}".`,
      nextAction:
        'Set memory.embeddings.provider in settings.yaml to openai or disable embeddings.',
    };
  }

  const apiKey = input.env.OPENAI_API_KEY?.trim() || '';
  if (!apiKey) {
    return {
      status: 'warn',
      message:
        'Embeddings are enabled with provider openai, but OPENAI_API_KEY is missing.',
      nextAction:
        'Set OPENAI_API_KEY in .env or run `myclaw memory embeddings off`. Memory still works without embeddings.',
    };
  }

  try {
    const client = new OpenAIEmbeddingClient(apiKey, input.embeddingModel);
    client.validateConfiguration();
    return {
      status: 'pass',
      message: `Embedding provider is ready (openai, model: ${input.embeddingModel}).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      message: 'Embedding provider configuration is invalid.',
      nextAction: `Fix memory.embeddings.model/provider config. Details: ${message}`,
    };
  }
}

export function inspectMemoryHealth(
  runtimeHome: string,
  settings: RuntimeSettings | undefined,
  env: Record<string, string | undefined>,
): MemoryHealthInspection {
  const warnings: HealthCheckResult[] = [];
  const settingsMemory = settings?.memory;
  const storageProvider = 'postgres';

  const memoryEnabled = settingsMemory?.enabled ?? true;
  const embeddingsEnabled = settingsMemory?.embeddings.enabled ?? false;
  const dreamingEnabled = settingsMemory?.dreaming.enabled ?? false;
  const embeddingProvider = settingsMemory
    ? settingsMemory.embeddings.enabled
      ? settingsMemory.embeddings.provider
      : 'disabled'
    : 'disabled';
  const embeddingModel =
    settingsMemory?.embeddings.model || 'text-embedding-3-large';

  const memoryRoot = resolveRuntimePath(
    runtimeHome,
    settingsMemory?.root,
    'memory',
  );
  const memoryCheck = inspectMemoryStorage(memoryEnabled, memoryRoot);
  const embeddingCheck = inspectEmbeddings({
    memoryEnabled,
    embeddingsEnabled,
    embeddingProvider,
    embeddingModel,
    env,
  });

  return {
    storageProvider,
    memoryEnabled,
    embeddingsEnabled,
    dreamingEnabled,
    embeddingProvider,
    memoryRoot,
    embeddingModel,
    memorySource: settingsMemory ? 'settings.yaml' : 'default',
    memoryRootSource: settingsMemory?.root ? 'settings.yaml' : 'default',
    embeddingProviderSource: settingsMemory ? 'settings.yaml' : 'default',
    embeddingModelSource: settingsMemory?.embeddings.model
      ? 'settings.yaml'
      : 'default',
    dreamingSource: settingsMemory ? 'settings.yaml' : 'default',
    memoryCheck,
    embeddingCheck,
    warnings,
  };
}

export interface MemoryJournalGroupStatus {
  groupFolder: string;
  fileCount: number;
  totalBytes: number;
  lastEventAt: string | null;
  stale: boolean;
  oversized: boolean;
}

export interface MemoryJournalStatusReport {
  journalRoot: string;
  groups: MemoryJournalGroupStatus[];
}

function resolveJournalRoot(
  runtimeHome: string,
  settings: RuntimeSettings | undefined,
): string {
  const memoryRoot = resolveRuntimePath(
    runtimeHome,
    settings?.memory?.root,
    'memory',
  );
  return path.join(memoryRoot, '.journal');
}

function parseLatestEventTimestamp(filePath: string): number {
  try {
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      let parsed: { ts?: string } | null = null;
      try {
        parsed = JSON.parse(line) as { ts?: string };
      } catch {
        continue;
      }
      if (!parsed.ts) continue;
      const ts = Date.parse(parsed.ts);
      if (Number.isFinite(ts)) return ts;
    }
  } catch {
    // Fallback to mtime below.
  }
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function inspectMemoryJournalStatus(
  runtimeHome: string,
  settings: RuntimeSettings | undefined,
): MemoryJournalStatusReport {
  const journalRoot = resolveJournalRoot(runtimeHome, settings);
  if (!fs.existsSync(journalRoot)) {
    return {
      journalRoot,
      groups: [],
    };
  }

  const now = Date.now();
  const groups: MemoryJournalGroupStatus[] = [];
  const entries = fs.readdirSync(journalRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'checkpoints') continue;
    const groupFolder = entry.name;
    const groupDir = path.join(journalRoot, groupFolder);
    const files = fs
      .readdirSync(groupDir, { withFileTypes: true })
      .filter(
        (child) =>
          child.isFile() && /^events-\d{4}-\d{2}\.jsonl$/.test(child.name),
      )
      .map((child) => path.join(groupDir, child.name));
    if (files.length === 0) continue;
    let totalBytes = 0;
    let latestMs = 0;
    for (const filePath of files) {
      try {
        totalBytes += fs.statSync(filePath).size;
      } catch {
        // Ignore unreadable files.
      }
      latestMs = Math.max(latestMs, parseLatestEventTimestamp(filePath));
    }
    const stale = latestMs > 0 ? now - latestMs > 24 * 60 * 60 * 1000 : false;
    const oversized = totalBytes > 200 * 1024 * 1024;
    groups.push({
      groupFolder,
      fileCount: files.length,
      totalBytes,
      lastEventAt: latestMs > 0 ? new Date(latestMs).toISOString() : null,
      stale,
      oversized,
    });
  }

  groups.sort((a, b) => a.groupFolder.localeCompare(b.groupFolder));
  return { journalRoot, groups };
}