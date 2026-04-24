import fs from 'fs';
import path from 'path';

import {
  MemoryService,
  type MemoryServiceCounters,
} from '../memory/memory-service.js';
import { readEnvFile } from '../config/env/file.js';
import {
  inspectMemoryHealth,
  inspectMemoryJournalStatus,
  type MemoryHealthInspection,
  type MemoryJournalStatusReport,
} from './memory-health.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';

export type MemoryMode =
  | 'keyword-mode'
  | 'continuity-mode'
  | 'semantic-mode'
  | 'full-mode';

export interface MemoryLiveCounts {
  items: number;
  procedures: number;
  pinnedItems: number;
  loadBearingItems: number;
  events: number;
}

export interface MemoryRecentEvent {
  eventType: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
}

export interface MemoryCheckpointInfo {
  path: string;
  mtime: string;
  sizeBytes: number;
}

export interface MemorySourceCount {
  source: string;
  fileCount: number;
  lastModified: string | null;
}

export interface MemoryStatusSnapshot {
  runtimeHome: string;
  health: MemoryHealthInspection;
  mode: MemoryMode;
  modeNote: string | null;
  journal: MemoryJournalStatusReport;
  latestCheckpoint: MemoryCheckpointInfo | null;
  sourceCounts: MemorySourceCount[];
  counters: MemoryServiceCounters;
  countersScope: 'process-local';
}

export function deriveMemoryMode(health: MemoryHealthInspection): {
  mode: MemoryMode;
  note: string | null;
} {
  const embeddingsOn =
    health.embeddingsEnabled && health.embeddingProvider !== 'disabled';
  const dreamingOn = health.dreamingEnabled;
  if (embeddingsOn && dreamingOn) {
    return {
      mode: 'full-mode',
      note: null,
    };
  }
  if (embeddingsOn) {
    return {
      mode: 'semantic-mode',
      note: null,
    };
  }
  if (dreamingOn) {
    return {
      mode: 'continuity-mode',
      note: 'dreaming is on and embeddings are off - this is the default local setup; enable embeddings later for semantic consolidation',
    };
  }
  return {
    mode: 'keyword-mode',
    note: null,
  };
}

function findLatestCheckpoint(
  journalRoot: string,
): MemoryCheckpointInfo | null {
  const checkpointDir = path.join(journalRoot, 'checkpoints');
  if (!fs.existsSync(checkpointDir)) return null;
  const entries = fs
    .readdirSync(checkpointDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      return /^memory-[0-9]{8}(?:-[0-9]{6}|[0-9]{6})\.db$/.test(entry.name);
    });
  if (entries.length === 0) return null;

  let selected: {
    filePath: string;
    mtimeMs: number;
    size: number;
  } | null = null;
  for (const entry of entries) {
    const filePath = path.join(checkpointDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (!selected || stat.mtimeMs > selected.mtimeMs) {
        selected = {
          filePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        };
      }
    } catch {
      // Ignore unreadable files and keep scanning.
    }
  }

  if (!selected) return null;
  return {
    path: selected.filePath,
    mtime: new Date(selected.mtimeMs).toISOString(),
    sizeBytes: selected.size,
  };
}

function collectSourceCounts(memoryRoot: string): MemorySourceCount[] {
  if (!fs.existsSync(memoryRoot)) return [];
  const entries = fs
    .readdirSync(memoryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const results: MemorySourceCount[] = [];
  for (const entry of entries) {
    const sourceDir = path.join(memoryRoot, entry.name);
    let fileCount = 0;
    let latest = 0;
    const stack = [sourceDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      let children: fs.Dirent[] = [];
      try {
        children = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (child.name.startsWith('.')) continue;
        const fullPath = path.join(current, child.name);
        if (child.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!child.isFile() || !child.name.toLowerCase().endsWith('.md')) {
          continue;
        }
        fileCount += 1;
        try {
          const stat = fs.statSync(fullPath);
          latest = Math.max(latest, stat.mtimeMs);
        } catch {
          // ignore unreadable files
        }
      }
    }
    results.push({
      source: entry.name,
      fileCount,
      lastModified: latest > 0 ? new Date(latest).toISOString() : null,
    });
  }
  return results;
}

export function collectMemoryStatus(runtimeHome: string): MemoryStatusSnapshot {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  const { mode, note } = deriveMemoryMode(health);
  const journal = inspectMemoryJournalStatus(runtimeHome, settings);
  const latestCheckpoint = findLatestCheckpoint(journal.journalRoot);
  const sourceCounts = collectSourceCounts(health.memoryRoot);

  return {
    runtimeHome,
    health,
    mode,
    modeNote: note,
    journal,
    latestCheckpoint,
    sourceCounts,
    counters: MemoryService.getCountersSnapshot(),
    countersScope: 'process-local',
  };
}

export function formatMemoryStatusExtras(
  snapshot: MemoryStatusSnapshot,
): string {
  const lines: string[] = [];
  lines.push(`Mode: ${snapshot.mode}`);
  if (snapshot.modeNote) {
    lines.push(`  note: ${snapshot.modeNote}`);
  }
  lines.push('');
  lines.push('Live Store');
  lines.push('  backend: Postgres runtime storage');
  lines.push(
    '  counts: available through runtime control events and DB observability',
  );
  lines.push('');
  lines.push('Sources');
  if (snapshot.sourceCounts.length === 0) {
    lines.push('  no markdown sources');
  } else {
    for (const source of snapshot.sourceCounts) {
      lines.push(
        `  ${source.source}: files=${source.fileCount}${source.lastModified ? ` (last=${source.lastModified})` : ''}`,
      );
    }
  }
  lines.push('');
  lines.push('Journal');
  lines.push(`  root: ${snapshot.journal.journalRoot}`);
  if (snapshot.journal.groups.length === 0) {
    lines.push('  no groups');
  } else {
    let totalFiles = 0;
    let totalBytes = 0;
    let stale = 0;
    let oversized = 0;
    for (const group of snapshot.journal.groups) {
      totalFiles += group.fileCount;
      totalBytes += group.totalBytes;
      if (group.stale) stale += 1;
      if (group.oversized) oversized += 1;
    }
    lines.push(
      `  groups=${snapshot.journal.groups.length} files=${totalFiles} bytes=${totalBytes} stale=${stale} oversized=${oversized}`,
    );
  }
  if (snapshot.latestCheckpoint) {
    lines.push(
      `  last checkpoint: ${snapshot.latestCheckpoint.path} (${snapshot.latestCheckpoint.mtime}, ${snapshot.latestCheckpoint.sizeBytes} bytes)`,
    );
  } else {
    lines.push('  last checkpoint: none');
  }
  lines.push('');
  lines.push('Counters');
  lines.push('  scope: process-local (this CLI invocation only)');
  for (const [key, value] of Object.entries(snapshot.counters)) {
    lines.push(`  ${key}: ${value}`);
  }
  return lines.join('\n');
}