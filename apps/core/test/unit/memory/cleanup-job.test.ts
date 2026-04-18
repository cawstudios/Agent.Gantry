import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { MEMORY_VECTOR_DIMENSIONS } from '@core/core/config.js';
import { AgentMemoryRootService } from '@core/memory/agent-memory-root.js';
import { runMemoryCleanupOnce } from '@core/memory/cleanup-job.js';
import { MemoryStore } from '@core/memory/memory-store.js';

const tempRoots: string[] = [];

function vector(seed: number): number[] {
  const out = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
  out[seed % MEMORY_VECTOR_DIMENSIONS] = 1;
  return out;
}

afterEach(() => {
  AgentMemoryRootService.resetForTests();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runMemoryCleanupOnce', () => {
  it('purges deleted items and dependent usage/vector rows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-cleanup-'));
    tempRoots.push(root);
    AgentMemoryRootService.setRootForTests(path.join(root, 'agent-memory'));
    const memoryRoot = AgentMemoryRootService.getInstance();
    const sqlitePath = memoryRoot.getSqliteCachePath();

    const store = new MemoryStore(sqlitePath);
    const saved = store.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'cleanup_target',
      value: 'This row should be purged.',
      source: 'test',
      confidence: 0.9,
    });
    store.saveItemEmbedding(saved.id, vector(3));
    store.close();

    const dbBefore = new Database(sqlitePath);
    dbBefore
      .prepare(
        `UPDATE memory_items
         SET is_deleted = 1,
             deleted_at = datetime('now', '-365 days')
         WHERE id = ?`,
      )
      .run(saved.id);
    dbBefore
      .prepare(
        `INSERT INTO memory_usage_events(item_id, turn_id, event, at)
         VALUES (?, ?, 'retrieved', datetime('now', '-30 days'))`,
      )
      .run(saved.id, 'turn-1');
    const mapCountBefore = dbBefore
      .prepare(
        `SELECT COUNT(1) AS count FROM memory_item_vector_map WHERE item_id = ?`,
      )
      .get(saved.id) as { count: number };
    expect(mapCountBefore.count).toBe(1);
    dbBefore.close();

    const result = runMemoryCleanupOnce();
    expect(result.purgedItems).toBe(1);

    const dbAfter = new Database(sqlitePath);
    const itemAfter = dbAfter
      .prepare(`SELECT 1 AS found FROM memory_items WHERE id = ?`)
      .get(saved.id);
    const usageAfter = dbAfter
      .prepare(
        `SELECT COUNT(1) AS count FROM memory_usage_events WHERE item_id = ?`,
      )
      .get(saved.id) as { count: number };
    const mapAfter = dbAfter
      .prepare(
        `SELECT COUNT(1) AS count FROM memory_item_vector_map WHERE item_id = ?`,
      )
      .get(saved.id) as { count: number };
    expect(itemAfter).toBeUndefined();
    expect(usageAfter.count).toBe(0);
    expect(mapAfter.count).toBe(0);
    dbAfter.close();
  });
});
