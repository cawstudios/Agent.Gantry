import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import Database from 'better-sqlite3';

import {
  MEMORY_CLEANUP_PURGE_DAYS,
  MEMORY_JOURNAL_DELETE_DAYS,
  MEMORY_JOURNAL_GZIP_DAYS,
} from '../core/config.js';
import { AgentMemoryRootService } from './agent-memory-root.js';

export interface MemoryCleanupResult {
  sweptMirrors: number;
  mirrorErrors: number;
  purgedItems: number;
  purgedProcedures: number;
  journalGzipped: number;
  journalDeleted: number;
}

function gzipFile(filePath: string): void {
  const data = fs.readFileSync(filePath);
  fs.writeFileSync(`${filePath}.gz`, zlib.gzipSync(data));
  fs.rmSync(filePath, { force: true });
}

function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stack = [root];
  const out: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

export function runMemoryCleanupOnce(): MemoryCleanupResult {
  const memoryRoot = AgentMemoryRootService.getInstance();
  const layout = memoryRoot.getLayout();
  const db = new Database(memoryRoot.getSqliteCachePath());

  let sweptMirrors = 0;
  let mirrorErrors = 0;
  let purgedItems = 0;
  let purgedProcedures = 0;
  let journalGzipped = 0;
  let journalDeleted = 0;

  try {
    const profileFiles = listFilesRecursive(layout.profileDir).filter((file) =>
      file.endsWith('.md'),
    );
    for (const filePath of profileFiles) {
      const id = path.basename(filePath, '.md');
      try {
        const row = db
          .prepare(
            `SELECT 1 FROM memory_items WHERE id = ? AND is_deleted = 0 LIMIT 1`,
          )
          .get(id) as { 1?: number } | undefined;
        if (!row) {
          fs.rmSync(filePath, { force: true });
          sweptMirrors += 1;
        }
      } catch {
        mirrorErrors += 1;
      }
    }

    const procedureFiles = listFilesRecursive(layout.proceduresDir).filter(
      (file) => file.endsWith('.md'),
    );
    for (const filePath of procedureFiles) {
      const id = path.basename(filePath, '.md');
      try {
        const row = db
          .prepare(
            `SELECT 1 FROM memory_procedures WHERE id = ? AND is_deleted = 0 LIMIT 1`,
          )
          .get(id) as { 1?: number } | undefined;
        if (!row) {
          fs.rmSync(filePath, { force: true });
          sweptMirrors += 1;
        }
      } catch {
        mirrorErrors += 1;
      }
    }

    const purgeItemRows = db
      .prepare(
        `SELECT id
         FROM memory_items
         WHERE is_deleted = 1
           AND deleted_at IS NOT NULL
           AND deleted_at < datetime('now', ?)`,
      )
      .all(`-${MEMORY_CLEANUP_PURGE_DAYS} days`) as Array<{
      id?: string;
    }>;
    if (purgeItemRows.length > 0) {
      const deleteUsageEvents = db.prepare(
        `DELETE FROM memory_usage_events WHERE item_id = ?`,
      );
      const deleteItem = db.prepare(`DELETE FROM memory_items WHERE id = ?`);
      const deleteItemVecMap = db.prepare(
        `DELETE FROM memory_item_vector_map WHERE item_id = ?`,
      );
      let selectItemVecRows: Database.Statement | null = null;
      let deleteItemVecRow: Database.Statement | null = null;
      try {
        selectItemVecRows = db.prepare(
          `SELECT vec_rowid FROM memory_item_vector_map WHERE item_id = ?`,
        );
        deleteItemVecRow = db.prepare(
          `DELETE FROM memory_items_vec WHERE rowid = ?`,
        );
      } catch {
        selectItemVecRows = null;
        deleteItemVecRow = null;
      }
      const txn = db.transaction((rows: Array<{ id?: string }>) => {
        for (const row of rows) {
          const id = typeof row.id === 'string' ? row.id : '';
          if (!id) continue;
          deleteUsageEvents.run(id);
          if (selectItemVecRows && deleteItemVecRow) {
            try {
              const vecRows = selectItemVecRows.all(id) as Array<{
                vec_rowid?: number;
              }>;
              for (const vecRow of vecRows) {
                if (typeof vecRow.vec_rowid === 'number') {
                  deleteItemVecRow.run(vecRow.vec_rowid);
                }
              }
            } catch {
              // If vector module/table isn't available in this process, still purge base rows.
            }
          }
          deleteItemVecMap.run(id);
          deleteItem.run(id);
        }
      });
      txn(purgeItemRows);
      purgedItems = purgeItemRows.length;
    }
    purgedProcedures = db
      .prepare(
        `DELETE FROM memory_procedures
         WHERE is_deleted = 1
           AND deleted_at IS NOT NULL
           AND deleted_at < datetime('now', ?)`,
      )
      .run(`-${MEMORY_CLEANUP_PURGE_DAYS} days`).changes;

    const nowMs = Date.now();
    for (const filePath of listFilesRecursive(layout.journalDir)) {
      const stat = fs.statSync(filePath);
      const ageDays = (nowMs - stat.mtimeMs) / 86_400_000;
      if (filePath.endsWith('.gz')) {
        if (ageDays >= MEMORY_JOURNAL_DELETE_DAYS) {
          fs.rmSync(filePath, { force: true });
          journalDeleted += 1;
        }
        continue;
      }
      if (filePath.endsWith('.md') && ageDays >= MEMORY_JOURNAL_GZIP_DAYS) {
        gzipFile(filePath);
        journalGzipped += 1;
      }
    }
  } finally {
    db.close();
  }

  memoryRoot.appendJournalEntry({
    title: 'cleanup_mirror_completed',
    lines: [`swept: ${sweptMirrors}`, `errors: ${mirrorErrors}`],
  });
  memoryRoot.appendJournalEntry({
    title: 'cleanup_purge_completed',
    lines: [`items: ${purgedItems}`, `procedures: ${purgedProcedures}`],
  });
  memoryRoot.appendJournalEntry({
    title: 'cleanup_journal_rotated',
    lines: [`gzipped: ${journalGzipped}`, `deleted: ${journalDeleted}`],
  });

  return {
    sweptMirrors,
    mirrorErrors,
    purgedItems,
    purgedProcedures,
    journalGzipped,
    journalDeleted,
  };
}
