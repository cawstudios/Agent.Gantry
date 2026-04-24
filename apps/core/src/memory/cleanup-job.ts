import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import {
  MEMORY_CLEANUP_PURGE_DAYS,
  MEMORY_JOURNAL_DELETE_DAYS,
  MEMORY_JOURNAL_GZIP_DAYS,
} from '../config/index.js';
import { MemoryRootService } from './memory-root.js';
import { MemoryStore } from './persistence/store.js';

export interface MemoryCleanupResult {
  sweptMirrors: number;
  mirrorErrors: number;
  purgedItems: number;
  purgedProcedures: number;
  journalGzipped: number;
  journalDeleted: number;
  checkpointCreated: string | null;
  checkpointPruned: number;
}

function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stack = [root];
  const out: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile()) out.push(fullPath);
    }
  }
  return out;
}

function gzipFile(filePath: string): void {
  const data = fs.readFileSync(filePath);
  fs.writeFileSync(`${filePath}.gz`, zlib.gzipSync(data), { mode: 0o600 });
  fs.rmSync(filePath, { force: true });
}

export async function runMemoryCleanupOnce(): Promise<MemoryCleanupResult> {
  const layout = MemoryRootService.getInstance().getLayout();
  const now = Date.now();
  let journalGzipped = 0;
  let journalDeleted = 0;
  const cutoffIso = new Date(
    now - MEMORY_CLEANUP_PURGE_DAYS * 86_400_000,
  ).toISOString();
  const tombstones = await new MemoryStore().purgeDeletedBefore(cutoffIso);

  for (const filePath of listFilesRecursive(layout.journalDir)) {
    const ageDays = (now - fs.statSync(filePath).mtimeMs) / 86_400_000;
    if (filePath.endsWith('.jsonl') && ageDays >= MEMORY_JOURNAL_GZIP_DAYS) {
      gzipFile(filePath);
      journalGzipped += 1;
      continue;
    }
    if (filePath.endsWith('.gz') && ageDays >= MEMORY_JOURNAL_DELETE_DAYS) {
      fs.rmSync(filePath, { force: true });
      journalDeleted += 1;
    }
  }

  return {
    sweptMirrors: 0,
    mirrorErrors: 0,
    purgedItems: tombstones.purgedItems,
    purgedProcedures: tombstones.purgedProcedures,
    journalGzipped,
    journalDeleted,
    checkpointCreated: null,
    checkpointPruned: 0,
  };
}

export async function runMemoryCleanupInSubprocess(): Promise<MemoryCleanupResult> {
  return await runMemoryCleanupOnce();
}