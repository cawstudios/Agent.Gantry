import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';

import {
  AGENT_MEMORY_ROOT,
  MEMORY_CHUNK_RETENTION_DAYS,
  MEMORY_ITEM_MAX_PER_GROUP,
  MEMORY_MAX_CHUNKS_PER_GROUP,
  MEMORY_MAX_EVENTS,
  MEMORY_MAX_GLOBAL_CHUNKS,
  MEMORY_MAX_PROCEDURES_PER_GROUP,
  MEMORY_RETENTION_PIN_THRESHOLD,
  MEMORY_SQLITE_PATH,
  MEMORY_VECTOR_DIMENSIONS,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  MemoryChunk,
  MEMORY_GLOBAL_GROUP_FOLDER,
  MemoryItem,
  MemoryProcedure,
  MemoryScope,
  MemorySearchResult,
  SimilarMemoryItemMatch,
} from './memory-types.js';
import {
  buildFtsMatchQuery,
  createItemSearcher,
} from './memory-item-search.js';

export interface ChunkInsert {
  source_type: string;
  source_id: string;
  source_path: string;
  scope: MemoryScope;
  group_folder: string;
  kind: string;
  text: string;
  importance_weight?: number;
  embedding: number[] | null;
}

export interface MemoryStoreOptions {
  backupRootDir?: string;
}

interface ExplicitMemoryBackupItem {
  scope: MemoryScope;
  group_folder: string;
  user_id: string | null;
  kind: MemoryItem['kind'];
  key: string;
  value: string;
  why?: string;
  load_bearing?: boolean;
  source_turn_id?: string | null;
  source: string;
  confidence: number;
}

interface ExplicitMemoryBackupProcedure {
  scope: MemoryScope;
  group_folder: string;
  title: string;
  body: string;
  tags: string[];
  origin?: 'explicit' | 'accepted_suggestion';
  trigger?: string | null;
  source: string;
  confidence: number;
}

interface ExplicitMemoryBackupPayload {
  createdAt: string;
  reason: string;
  fromVersion: number;
  toVersion: number;
  pinnedItems: ExplicitMemoryBackupItem[];
  procedures: ExplicitMemoryBackupProcedure[];
  ephemeralChunkCount: number;
}

export class MemoryStore {
  private static readonly SCHEMA_VERSION = 4;
  private static readonly PRAGMA_TABLE_ALLOWLIST = new Set([
    'memory_items',
    'memory_chunks',
    'memory_procedures',
    'memory_events',
    'memory_usage_events',
    'embedding_cache',
  ]);
  private readonly db: Database.Database;
  private readonly backupRootDir: string;
  readonly searchItemsByText: ReturnType<typeof createItemSearcher>;

  constructor(dbPath = MEMORY_SQLITE_PATH, options: MemoryStoreOptions = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.backupRootDir = options.backupRootDir || AGENT_MEMORY_ROOT;
    this.searchItemsByText = createItemSearcher(this.db);
    this.initializeSchema();
    this.initializeVectorBackend();
  }

  close(): void {
    this.db.close();
  }

  runHealthChecks(): void {
    this.db.prepare('SELECT 1').get();

    const requiredObjects = [
      'memory_items',
      'memory_procedures',
      'memory_chunks',
      'memory_chunks_fts',
      'memory_chunk_vector_map',
      'memory_chunks_vec',
      'memory_item_vector_map',
      'memory_items_vec',
      'memory_events',
      'memory_usage_events',
      'embedding_cache',
    ];
    for (const objectName of requiredObjects) {
      const exists = this.db
        .prepare(`SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1`)
        .get(objectName) as { 1?: number } | undefined;
      if (!exists) {
        throw new Error(
          `memory storage health check failed: missing SQLite object "${objectName}"`,
        );
      }
    }
  }

  private initializeSchema(): void {
    const currentVersion = this.getSchemaVersion();
    if (currentVersion === 0) {
      this.createSchema();
      this.setSchemaVersion(MemoryStore.SCHEMA_VERSION);
      return;
    }

    if (currentVersion < MemoryStore.SCHEMA_VERSION) {
      const migrated = this.tryApplyAdditiveMigration(currentVersion);
      if (migrated) return;
      this.resetSchemaWithBackup(currentVersion, 'additive_migration_failed');
      return;
    }

    if (currentVersion > MemoryStore.SCHEMA_VERSION) {
      this.resetSchemaWithBackup(currentVersion, 'binary_older_than_db');
      return;
    }

    this.createSchema();
  }

  private getSchemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private setSchemaVersion(version: number): void {
    const normalized = Math.max(0, Math.trunc(version));
    this.db.pragma(`user_version = ${normalized}`);
  }

  private columnExists(tableName: string, columnName: string): boolean {
    if (!MemoryStore.PRAGMA_TABLE_ALLOWLIST.has(tableName)) {
      throw new Error(`Unsafe table name for PRAGMA table_info: ${tableName}`);
    }
    const rows = this.db
      .prepare(`PRAGMA table_info("${tableName}")`)
      .all() as Array<Record<string, unknown>>;
    return rows.some((row) => String(row.name) === columnName);
  }

  private tableExists(tableName: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      )
      .get(tableName) as { present?: number } | undefined;
    return row?.present === 1;
  }

  private ensureColumn(
    tableName: 'memory_items' | 'memory_procedures' | 'memory_chunks',
    columnName: string,
    definitionSql: string,
  ): void {
    if (!this.tableExists(tableName)) return;
    if (this.columnExists(tableName, columnName)) return;
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
  }

  private tryApplyAdditiveMigration(fromVersion: number): boolean {
    try {
      this.applyAdditiveMigrationToV4();
      this.createSchema();
      this.setSchemaVersion(MemoryStore.SCHEMA_VERSION);
      logger.info(
        {
          fromVersion,
          toVersion: MemoryStore.SCHEMA_VERSION,
        },
        '[MyClaw] memory schema upgraded via additive migration',
      );
      return true;
    } catch (err) {
      logger.warn(
        {
          err,
          fromVersion,
          toVersion: MemoryStore.SCHEMA_VERSION,
        },
        '[MyClaw] additive memory migration failed; falling back to reset',
      );
      return false;
    }
  }

  private applyAdditiveMigrationToV4(): void {
    const run = this.db.transaction(() => {
      this.ensureColumn('memory_items', 'why', 'why TEXT');
      this.ensureColumn(
        'memory_items',
        'load_bearing',
        'load_bearing INTEGER NOT NULL DEFAULT 0',
      );
      this.ensureColumn(
        'memory_items',
        'source_turn_id',
        'source_turn_id TEXT',
      );
      this.ensureColumn(
        'memory_items',
        'is_pinned',
        'is_pinned INTEGER NOT NULL DEFAULT 0',
      );
      this.ensureColumn(
        'memory_items',
        'used_count',
        'used_count INTEGER NOT NULL DEFAULT 0',
      );
      this.ensureColumn('memory_items', 'superseded_by', 'superseded_by TEXT');
      this.ensureColumn(
        'memory_items',
        'last_retrieved_at',
        'last_retrieved_at TEXT',
      );
      this.ensureColumn(
        'memory_items',
        'retrieval_count',
        'retrieval_count INTEGER NOT NULL DEFAULT 0',
      );
      this.ensureColumn(
        'memory_items',
        'total_score',
        'total_score REAL NOT NULL DEFAULT 0',
      );
      this.ensureColumn(
        'memory_items',
        'max_score',
        'max_score REAL NOT NULL DEFAULT 0',
      );
      this.ensureColumn(
        'memory_items',
        'query_hashes_json',
        "query_hashes_json TEXT NOT NULL DEFAULT '[]'",
      );
      this.ensureColumn(
        'memory_items',
        'recall_days_json',
        "recall_days_json TEXT NOT NULL DEFAULT '[]'",
      );
      this.ensureColumn(
        'memory_items',
        'embedding_json',
        'embedding_json TEXT',
      );
      this.ensureColumn('memory_items', 'deleted_at', 'deleted_at TEXT');
      this.ensureColumn(
        'memory_items',
        'last_reviewed_at',
        'last_reviewed_at TEXT',
      );

      this.ensureColumn(
        'memory_procedures',
        'origin',
        "origin TEXT NOT NULL DEFAULT 'explicit' CHECK(origin IN ('explicit','accepted_suggestion'))",
      );
      this.ensureColumn('memory_procedures', 'trigger', 'trigger TEXT');
      this.ensureColumn('memory_procedures', 'deleted_at', 'deleted_at TEXT');

      this.ensureColumn(
        'memory_chunks',
        'importance_weight',
        'importance_weight REAL NOT NULL DEFAULT 1.0',
      );
    });
    run();
  }

  private resetSchemaWithBackup(fromVersion: number, reason: string): void {
    const backup = this.exportExplicitMemoryBackup(fromVersion, reason);
    this.migrateToV4();
    this.setSchemaVersion(MemoryStore.SCHEMA_VERSION);
    const restored = this.restoreExplicitMemoryBackup(backup);

    this.recordEvent('memory_schema_reset', 'system', null, {
      reason,
      fromVersion,
      toVersion: MemoryStore.SCHEMA_VERSION,
      restoredPinnedItems: restored.pinnedItems,
      restoredProcedures: restored.procedures,
      droppedEphemeralChunks: backup.ephemeralChunkCount,
    });

    logger.warn(
      {
        reason,
        fromVersion,
        toVersion: MemoryStore.SCHEMA_VERSION,
        restoredPinnedItems: restored.pinnedItems,
        restoredProcedures: restored.procedures,
        droppedEphemeralChunks: backup.ephemeralChunkCount,
      },
      `[MyClaw] memory schema upgraded (v${fromVersion} -> v${MemoryStore.SCHEMA_VERSION}). ${restored.pinnedItems} pinned items and ${restored.procedures} procedures restored; ${backup.ephemeralChunkCount} ephemeral chunks dropped.`,
    );
  }

  private exportExplicitMemoryBackup(
    fromVersion: number,
    reason: string,
  ): ExplicitMemoryBackupPayload {
    const payload: ExplicitMemoryBackupPayload = {
      createdAt: new Date().toISOString(),
      reason,
      fromVersion,
      toVersion: MemoryStore.SCHEMA_VERSION,
      pinnedItems: this.readPinnedItemsForBackup(),
      procedures: this.readProceduresForBackup(),
      ephemeralChunkCount: this.countEphemeralChunks(),
    };
    this.writeBackupFile(payload);
    return payload;
  }

  private writeBackupFile(payload: ExplicitMemoryBackupPayload): void {
    try {
      const backupDir = path.join(this.backupRootDir, '.cache');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(
        backupDir,
        `pre-v${MemoryStore.SCHEMA_VERSION}-backup.json`,
      );
      fs.writeFileSync(backupPath, JSON.stringify(payload, null, 2));
    } catch (err) {
      logger.warn(
        { err },
        '[MyClaw] failed to persist memory schema backup file before reset',
      );
    }
  }

  private readPinnedItemsForBackup(): ExplicitMemoryBackupItem[] {
    if (!this.tableExists('memory_items')) return [];
    if (!this.columnExists('memory_items', 'is_pinned')) return [];
    const hasIsDeleted = this.columnExists('memory_items', 'is_deleted');
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE is_pinned = 1
           ${hasIsDeleted ? 'AND is_deleted = 0' : ''}`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      scope: this.toScope(row.scope),
      group_folder: String(row.group_folder || ''),
      user_id: row.user_id ? String(row.user_id) : null,
      kind: this.toMemoryKind(row.kind),
      key: String(row.key || ''),
      value: String(row.value || ''),
      why: row.why ? String(row.why) : undefined,
      load_bearing: Number(row.load_bearing || 0) === 1,
      source_turn_id: row.source_turn_id ? String(row.source_turn_id) : null,
      source: String(row.source || 'schema-reset-backup'),
      confidence: this.toConfidence(row.confidence),
    }));
  }

  private readProceduresForBackup(): ExplicitMemoryBackupProcedure[] {
    if (!this.tableExists('memory_procedures')) return [];
    const hasIsDeleted = this.columnExists('memory_procedures', 'is_deleted');
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_procedures
         ${hasIsDeleted ? 'WHERE is_deleted = 0' : ''}`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      scope: this.toScope(row.scope),
      group_folder: String(row.group_folder || ''),
      title: String(row.title || ''),
      body: String(row.body || ''),
      tags: this.parseTags(row.tags_json),
      origin:
        row.origin === 'accepted_suggestion'
          ? 'accepted_suggestion'
          : 'explicit',
      trigger: row.trigger ? String(row.trigger) : null,
      source: String(row.source || 'schema-reset-backup'),
      confidence: this.toConfidence(row.confidence),
    }));
  }

  private countEphemeralChunks(): number {
    if (!this.tableExists('memory_chunks')) return 0;
    const row = this.db
      .prepare(`SELECT COUNT(1) AS count FROM memory_chunks`)
      .get() as { count?: number } | undefined;
    return Number(row?.count || 0);
  }

  private restoreExplicitMemoryBackup(payload: ExplicitMemoryBackupPayload): {
    pinnedItems: number;
    procedures: number;
  } {
    let restoredPinnedItems = 0;
    let restoredProcedures = 0;
    for (const item of payload.pinnedItems) {
      try {
        this.saveItem({
          scope: item.scope,
          group_folder: item.group_folder,
          user_id: item.user_id,
          kind: item.kind,
          key: item.key,
          value: item.value,
          why: item.why,
          load_bearing: item.load_bearing,
          source_turn_id: item.source_turn_id,
          source: item.source || 'schema-reset-backup',
          confidence: item.confidence,
          is_pinned: true,
        });
        restoredPinnedItems += 1;
      } catch (err) {
        logger.warn(
          { err, key: item.key, group: item.group_folder },
          '[MyClaw] failed to restore pinned memory item from schema backup',
        );
      }
    }
    for (const procedure of payload.procedures) {
      try {
        this.saveProcedure({
          scope: procedure.scope,
          group_folder: procedure.group_folder,
          title: procedure.title,
          body: procedure.body,
          tags: procedure.tags,
          origin: procedure.origin,
          trigger: procedure.trigger,
          source: procedure.source || 'schema-reset-backup',
          confidence: procedure.confidence,
        });
        restoredProcedures += 1;
      } catch (err) {
        logger.warn(
          { err, title: procedure.title, group: procedure.group_folder },
          '[MyClaw] failed to restore memory procedure from schema backup',
        );
      }
    }
    return {
      pinnedItems: restoredPinnedItems,
      procedures: restoredProcedures,
    };
  }

  private toScope(value: unknown): MemoryScope {
    const scope = String(value || 'group');
    if (scope === 'global' || scope === 'user') return scope;
    return 'group';
  }

  private toMemoryKind(value: unknown): MemoryItem['kind'] {
    const kind = String(value || 'fact');
    if (
      kind === 'preference' ||
      kind === 'decision' ||
      kind === 'fact' ||
      kind === 'correction' ||
      kind === 'constraint'
    ) {
      return kind;
    }
    return 'fact';
  }

  private toConfidence(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0.5;
    return Math.max(0, Math.min(1, parsed));
  }

  private parseTags(value: unknown): string[] {
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private migrateToV4(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS memory_item_vector_map;
      DROP TABLE IF EXISTS memory_chunk_vector_map;
      DROP TABLE IF EXISTS memory_chunks_fts;
      DROP TABLE IF EXISTS memory_usage_events;
      DROP TABLE IF EXISTS memory_events;
      DROP TABLE IF EXISTS memory_chunks;
      DROP TABLE IF EXISTS memory_procedures;
      DROP TABLE IF EXISTS memory_items;
      DROP TABLE IF EXISTS embedding_cache;
    `);
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        user_id TEXT,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        why TEXT,
        load_bearing INTEGER NOT NULL DEFAULT 0,
        source_turn_id TEXT,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        used_count INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        last_retrieved_at TEXT,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        total_score REAL NOT NULL DEFAULT 0,
        max_score REAL NOT NULL DEFAULT 0,
        query_hashes_json TEXT NOT NULL DEFAULT '[]',
        recall_days_json TEXT NOT NULL DEFAULT '[]',
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        last_reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_items_scope_group ON memory_items(scope, group_folder, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_active_unique_key
      ON memory_items(scope, group_folder, COALESCE(user_id, ''), key)
      WHERE is_deleted = 0;

      CREATE TABLE IF NOT EXISTS memory_procedures (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'explicit' CHECK(origin IN ('explicit','accepted_suggestion')),
        trigger TEXT,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        version INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_procedures_scope_group ON memory_procedures(scope, group_folder, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        scope TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        kind TEXT NOT NULL,
        chunk_hash TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        importance_weight REAL NOT NULL DEFAULT 1.0,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_scope_group ON memory_chunks(scope, group_folder, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source_type, source_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        id UNINDEXED,
        text,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS memory_chunk_vector_map (
        chunk_id TEXT PRIMARY KEY,
        vec_rowid INTEGER NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS memory_item_vector_map (
        item_id TEXT PRIMARY KEY,
        vec_rowid INTEGER NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_events_type_time ON memory_events(event_type, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        turn_id TEXT,
        event TEXT CHECK(event IN ('retrieved', 'used', 'contradicted')) NOT NULL,
        at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(item_id) REFERENCES memory_items(id)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_item ON memory_usage_events(item_id);
      CREATE INDEX IF NOT EXISTS idx_usage_events_at ON memory_usage_events(at);

      CREATE TABLE IF NOT EXISTS embedding_cache (
        text_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (text_hash, model)
      );
    `);
  }

  private initializeVectorBackend(): void {
    try {
      loadSqliteVec(this.db);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(
          embedding float[${MEMORY_VECTOR_DIMENSIONS}]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_vec USING vec0(
          embedding float[${MEMORY_VECTOR_DIMENSIONS}]
        );
      `);
    } catch (err) {
      throw new Error(
        `sqlite-vec backend initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  static makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  static chunkHash(input: ChunkInsert): string {
    return crypto
      .createHash('sha256')
      .update(
        `${input.scope}:${input.group_folder}:${input.source_type}:${input.source_id}:${input.text}`,
      )
      .digest('hex');
  }

  saveItem(
    input: Pick<
      MemoryItem,
      | 'scope'
      | 'group_folder'
      | 'user_id'
      | 'kind'
      | 'key'
      | 'value'
      | 'why'
      | 'load_bearing'
      | 'source_turn_id'
      | 'source'
      | 'confidence'
    > & { is_pinned?: boolean; used_count?: number },
  ): MemoryItem {
    const now = new Date().toISOString();
    const id = MemoryStore.makeId('mem');
    this.db
      .prepare(
        `INSERT INTO memory_items
        (id, scope, group_folder, user_id, kind, key, value, why, load_bearing, source_turn_id, source, confidence, is_pinned, used_count, version, created_at, updated_at)
        VALUES (@id, @scope, @group_folder, @user_id, @kind, @key, @value, @why, @load_bearing, @source_turn_id, @source, @confidence, @is_pinned, @used_count, 1, @created_at, @updated_at)`,
      )
      .run({
        id,
        scope: input.scope,
        group_folder: input.group_folder,
        user_id: input.user_id,
        kind: input.kind,
        key: input.key,
        value: input.value,
        why: input.why ?? null,
        is_pinned: input.is_pinned ? 1 : 0,
        load_bearing: input.load_bearing ? 1 : 0,
        source_turn_id: input.source_turn_id ?? null,
        source: input.source,
        confidence: input.confidence,
        used_count: Math.max(0, Math.round(input.used_count || 0)),
        created_at: now,
        updated_at: now,
      });

    return this.getItemById(id)!;
  }

  findItemByKey(input: {
    scope: MemoryScope;
    groupFolder: string;
    key: string;
    userId?: string | null;
  }): MemoryItem | null {
    let row: Record<string, unknown> | undefined;

    if (input.scope === 'global') {
      row = this.db
        .prepare(
          `SELECT * FROM memory_items
           WHERE is_deleted = 0
             AND scope = 'global'
             AND key = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(input.key) as Record<string, unknown> | undefined;
    } else if (input.scope === 'user') {
      if (!input.userId) return null;
      row = this.db
        .prepare(
          `SELECT * FROM memory_items
           WHERE is_deleted = 0
             AND scope = 'user'
             AND group_folder = ?
             AND user_id = ?
             AND key = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(input.groupFolder, input.userId, input.key) as
        | Record<string, unknown>
        | undefined;
    } else {
      row = this.db
        .prepare(
          `SELECT * FROM memory_items
           WHERE is_deleted = 0
             AND scope = 'group'
             AND group_folder = ?
             AND key = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(input.groupFolder, input.key) as
        | Record<string, unknown>
        | undefined;
    }

    return row ? this.toItem(row) : null;
  }

  getItemById(id: string): MemoryItem | null {
    const row = this.db
      .prepare(`SELECT * FROM memory_items WHERE id = ? AND is_deleted = 0`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toItem(row) : null;
  }

  patchItem(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        MemoryItem,
        | 'key'
        | 'value'
        | 'why'
        | 'load_bearing'
        | 'confidence'
        | 'kind'
        | 'source'
        | 'source_turn_id'
        | 'superseded_by'
        | 'last_reviewed_at'
      >
    >,
  ): MemoryItem {
    const current = this.getItemById(id);
    if (!current) throw new Error('memory item not found');
    if (current.version !== expectedVersion) {
      throw new Error(
        `stale patch: expected version ${expectedVersion}, current ${current.version}`,
      );
    }

    const next = {
      key: patch.key ?? current.key,
      value: patch.value ?? current.value,
      why: patch.why ?? current.why ?? null,
      load_bearing:
        patch.load_bearing !== undefined
          ? patch.load_bearing
          : Boolean(current.load_bearing),
      source_turn_id:
        patch.source_turn_id !== undefined
          ? patch.source_turn_id
          : current.source_turn_id || null,
      superseded_by:
        patch.superseded_by !== undefined
          ? patch.superseded_by
          : current.superseded_by || null,
      last_reviewed_at:
        patch.last_reviewed_at !== undefined
          ? patch.last_reviewed_at
          : current.last_reviewed_at || null,
      kind: patch.kind ?? current.kind,
      source: patch.source ?? current.source,
      confidence: patch.confidence ?? current.confidence,
      updated_at: new Date().toISOString(),
      version: current.version + 1,
      id,
    };

    this.db
      .prepare(
        `UPDATE memory_items
        SET key = @key,
            value = @value,
            why = @why,
            load_bearing = @load_bearing,
            source_turn_id = @source_turn_id,
            superseded_by = @superseded_by,
            last_reviewed_at = @last_reviewed_at,
            kind = @kind,
            source = @source,
            confidence = @confidence,
            version = @version,
            updated_at = @updated_at
        WHERE id = @id`,
      )
      .run({
        ...next,
        load_bearing: next.load_bearing ? 1 : 0,
      });

    return this.getItemById(id)!;
  }

  pinItem(id: string, pinned = true): void {
    this.db
      .prepare(
        `UPDATE memory_items SET is_pinned = ?, updated_at = ? WHERE id = ?`,
      )
      .run(pinned ? 1 : 0, new Date().toISOString(), id);
  }

  saveItemEmbedding(itemId: string, embedding: number[]): void {
    if (!Array.isArray(embedding) || embedding.length === 0) return;
    const now = new Date().toISOString();
    const serialized = JSON.stringify(embedding);
    const existing = this.db
      .prepare(`SELECT vec_rowid FROM memory_item_vector_map WHERE item_id = ?`)
      .get(itemId) as { vec_rowid?: number } | undefined;

    if (existing?.vec_rowid !== undefined) {
      this.db
        .prepare(`UPDATE memory_items_vec SET embedding = ? WHERE rowid = ?`)
        .run(serialized, existing.vec_rowid);
    } else {
      const vecInsert = this.db
        .prepare(`INSERT INTO memory_items_vec(embedding) VALUES (?)`)
        .run(serialized);
      this.db
        .prepare(
          `INSERT INTO memory_item_vector_map(item_id, vec_rowid) VALUES (?, ?)`,
        )
        .run(itemId, Number(vecInsert.lastInsertRowid));
    }

    this.db
      .prepare(
        `UPDATE memory_items
         SET embedding_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(serialized, now, itemId);
  }

  getCachedEmbedding(textHash: string, model: string): number[] | null {
    const row = this.db
      .prepare(
        `SELECT embedding_json
         FROM embedding_cache
         WHERE text_hash = ?
           AND model = ?
         LIMIT 1`,
      )
      .get(textHash, model) as { embedding_json?: string } | undefined;
    if (!row?.embedding_json) return null;
    try {
      const parsed = JSON.parse(row.embedding_json) as unknown;
      if (!Array.isArray(parsed)) return null;
      const embedding = parsed.map((value) => Number(value));
      if (embedding.some((value) => !Number.isFinite(value))) return null;
      return embedding;
    } catch {
      return null;
    }
  }

  putCachedEmbedding(
    textHash: string,
    model: string,
    embedding: number[],
  ): void {
    if (!Array.isArray(embedding) || embedding.length === 0) return;
    this.db
      .prepare(
        `INSERT INTO embedding_cache(text_hash, model, embedding_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(text_hash, model) DO UPDATE SET
           embedding_json = excluded.embedding_json,
           created_at = excluded.created_at`,
      )
      .run(
        textHash,
        model,
        JSON.stringify(embedding),
        new Date().toISOString(),
      );
  }

  findSimilarItems(input: {
    scope: MemoryScope;
    groupFolder: string;
    userId?: string | null;
    embedding: number[];
    limit?: number;
  }): SimilarMemoryItemMatch[] {
    const limit = Math.max(1, Math.min(50, input.limit ?? 5));
    const candidateLimit = Math.max(limit, Math.min(limit * 6, 250));
    const rows = this.db
      .prepare(
        `WITH nearest AS (
           SELECT rowid, distance
           FROM memory_items_vec
           WHERE embedding MATCH @embedding
             AND k = @candidate_limit
         )
         SELECT i.*, n.distance
         FROM nearest n
         JOIN memory_item_vector_map m ON m.vec_rowid = n.rowid
         JOIN memory_items i ON i.id = m.item_id
         WHERE i.is_deleted = 0
           AND i.scope = @scope
           AND (@scope = 'global' OR i.group_folder = @group_folder)
           AND (@scope != 'user' OR (@user_id IS NOT NULL AND i.user_id = @user_id))
         ORDER BY n.distance ASC
         LIMIT @limit`,
      )
      .all({
        embedding: JSON.stringify(input.embedding),
        candidate_limit: candidateLimit,
        scope: input.scope,
        group_folder: input.groupFolder,
        user_id: input.userId ?? null,
        limit,
      }) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const distance = Number(row.distance);
      const similarity = Number.isFinite(distance) ? 1 / (1 + distance) : 0;
      return { item: this.toItem(row), similarity };
    });
  }

  listActiveItems(groupFolder: string, limit = 5000): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE is_deleted = 0
           AND scope != 'global'
           AND group_folder = @group_folder
         ORDER BY confidence DESC, updated_at DESC
         LIMIT @limit`,
      )
      .all({
        group_folder: groupFolder,
        limit: Math.max(1, limit),
      }) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toItem(row));
  }

  softDeleteItem(id: string, supersededBy?: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE memory_items
         SET is_deleted = 1,
             deleted_at = ?,
             superseded_by = COALESCE(?, superseded_by),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(now, supersededBy ?? null, now, id);
    this.deleteItemVectorsByIds([id]);
  }

  incrementRetrievalCount(ids: string[]): void {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    const now = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE memory_items
       SET retrieval_count = retrieval_count + 1,
           last_retrieved_at = ?
       WHERE id = ?
         AND is_deleted = 0`,
    );
    const txn = this.db.transaction((itemIds: string[]) => {
      for (const id of itemIds) {
        update.run(now, id);
      }
    });
    txn(unique);
  }

  recordRetrievalSignal(
    itemId: string,
    score: number,
    queryHash: string,
  ): void {
    if (!itemId) return;
    const row = this.db
      .prepare(
        `SELECT retrieval_count, total_score, max_score, query_hashes_json, recall_days_json
         FROM memory_items
         WHERE id = ?
           AND is_deleted = 0`,
      )
      .get(itemId) as
      | {
          retrieval_count?: number;
          total_score?: number;
          max_score?: number;
          query_hashes_json?: string;
          recall_days_json?: string;
        }
      | undefined;
    if (!row) return;

    const safeScore = Number.isFinite(score) && score > 0 ? score : 0;
    const queryHashes = this.parseStringArray(row.query_hashes_json);
    if (queryHash) {
      queryHashes.push(queryHash);
    }
    const uniqueQueryHashes = [...new Set(queryHashes)].slice(-50);

    const recallDays = this.parseStringArray(row.recall_days_json);
    recallDays.push(new Date().toISOString().slice(0, 10));
    const uniqueRecallDays = [...new Set(recallDays)].slice(-90);

    this.db
      .prepare(
        `UPDATE memory_items
         SET retrieval_count = retrieval_count + 1,
             last_retrieved_at = ?,
             total_score = total_score + ?,
             max_score = MAX(max_score, ?),
             query_hashes_json = ?,
             recall_days_json = ?
         WHERE id = ?
           AND is_deleted = 0`,
      )
      .run(
        new Date().toISOString(),
        safeScore,
        safeScore,
        JSON.stringify(uniqueQueryHashes),
        JSON.stringify(uniqueRecallDays),
        itemId,
      );
  }

  bumpConfidence(ids: string[], delta: number): void {
    if (Number.isNaN(delta)) return;
    if (delta <= 0) return;
    this.adjustConfidence(ids, delta);
  }

  adjustConfidence(ids: string[], delta: number): void {
    if (Number.isNaN(delta)) return;
    if (delta === 0) return;
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    const update = this.db.prepare(
      `UPDATE memory_items
         SET confidence = MIN(1.0, MAX(0.0, confidence + ?)),
           updated_at = ?
       WHERE id = ?
         AND is_deleted = 0`,
    );
    const now = new Date().toISOString();
    const txn = this.db.transaction((itemIds: string[]) => {
      for (const id of itemIds) {
        update.run(delta, now, id);
      }
    });
    txn(unique);
  }

  decayUnusedConfidence(groupFolder: string, delta: number): number {
    if (delta <= 0) return 0;
    const now = new Date().toISOString();

    const decayed = this.db
      .prepare(
        `UPDATE memory_items
         SET confidence = MIN(1.0, MAX(0.0, confidence - @delta)),
             updated_at = @updated_at
         WHERE is_deleted = 0
           AND is_pinned = 0
           AND retrieval_count = 0
           AND (scope = 'global' OR group_folder = @group_folder)`,
      )
      .run({
        delta,
        updated_at: now,
        group_folder: groupFolder,
      });

    return decayed.changes;
  }

  countReflectionsSinceLastUsageDecay(groupFolder: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(1) AS count
         FROM memory_events
         WHERE event_type = 'reflection_completed'
           AND entity_id = @group_folder
           AND id > COALESCE((
             SELECT MAX(id)
             FROM memory_events
             WHERE event_type = 'usage_decay_run'
               AND entity_id = @group_folder
           ), 0)`,
      )
      .get({ group_folder: groupFolder }) as { count?: number } | undefined;
    return Math.max(0, Number(row?.count || 0));
  }

  recordUsageDecayRun(groupFolder: string): void {
    this.recordEvent('usage_decay_run', 'memory_usage', groupFolder, {
      group_folder: groupFolder,
      created_at: new Date().toISOString(),
    });
  }

  listTopItems(
    scope: MemoryScope,
    groupFolder: string,
    limit: number,
    userId?: string,
  ): MemoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE is_deleted = 0
         AND scope = @scope
         AND (scope = 'global' OR group_folder = @group_folder)
         AND (@scope != 'user' OR (@user_id IS NOT NULL AND user_id = @user_id))
         ORDER BY confidence DESC, COALESCE(last_used_at, updated_at) DESC
         LIMIT @limit`,
      )
      .all({
        scope,
        group_folder: groupFolder,
        user_id: userId || null,
        limit,
      }) as Record<string, unknown>[];
    return rows.map((row) => this.toItem(row));
  }

  chunkExists(input: ChunkInsert): boolean {
    const chunkHash = MemoryStore.chunkHash(input);
    const row = this.db
      .prepare(`SELECT 1 AS found FROM memory_chunks WHERE chunk_hash = ?`)
      .get(chunkHash) as { found?: number } | undefined;
    return row?.found === 1;
  }

  touchItem(id: string): void {
    this.db
      .prepare(`UPDATE memory_items SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  saveProcedure(
    input: Omit<
      MemoryProcedure,
      | 'id'
      | 'version'
      | 'created_at'
      | 'updated_at'
      | 'last_used_at'
      | 'is_deleted'
      | 'deleted_at'
    >,
  ): MemoryProcedure {
    const now = new Date().toISOString();
    const id = MemoryStore.makeId('proc');
    this.db
      .prepare(
        `INSERT INTO memory_procedures
        (id, scope, group_folder, title, body, tags_json, origin, trigger, source, confidence, version, created_at, updated_at)
        VALUES (@id, @scope, @group_folder, @title, @body, @tags_json, @origin, @trigger, @source, @confidence, 1, @created_at, @updated_at)`,
      )
      .run({
        id,
        scope: input.scope,
        group_folder: input.group_folder,
        title: input.title,
        body: input.body,
        tags_json: JSON.stringify(input.tags),
        origin: input.origin || 'explicit',
        trigger: input.trigger || null,
        source: input.source,
        confidence: input.confidence,
        created_at: now,
        updated_at: now,
      });

    return this.getProcedureById(id)!;
  }

  getProcedureById(id: string): MemoryProcedure | null {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_procedures WHERE id = ? AND is_deleted = 0`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toProcedure(row) : null;
  }

  patchProcedure(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        MemoryProcedure,
        'title' | 'body' | 'tags' | 'trigger' | 'confidence'
      >
    >,
  ): MemoryProcedure {
    const current = this.getProcedureById(id);
    if (!current) throw new Error('memory procedure not found');
    if (current.version !== expectedVersion) {
      throw new Error(
        `stale patch: expected version ${expectedVersion}, current ${current.version}`,
      );
    }

    const next = {
      id,
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      tags_json: JSON.stringify(patch.tags ?? current.tags),
      trigger:
        patch.trigger !== undefined ? patch.trigger : current.trigger || null,
      confidence: patch.confidence ?? current.confidence,
      version: current.version + 1,
      updated_at: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE memory_procedures
         SET title = @title,
             body = @body,
             tags_json = @tags_json,
             trigger = @trigger,
             confidence = @confidence,
             version = @version,
             updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(next);

    return this.getProcedureById(id)!;
  }

  listTopProcedures(groupFolder: string, limit: number): MemoryProcedure[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_procedures
         WHERE is_deleted = 0
         AND (scope = 'global' OR (scope = 'group' AND group_folder = @group_folder))
         ORDER BY confidence DESC, COALESCE(last_used_at, updated_at) DESC
         LIMIT @limit`,
      )
      .all({ group_folder: groupFolder, limit }) as Record<string, unknown>[];
    return rows.map((row) => this.toProcedure(row));
  }

  softDeleteProcedure(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE memory_procedures
         SET is_deleted = 1,
             deleted_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, id);
  }

  saveChunks(chunks: ChunkInsert[]): number {
    const now = new Date().toISOString();
    const insertChunk = this.db.prepare(
      `INSERT OR IGNORE INTO memory_chunks
      (id, source_type, source_id, source_path, scope, group_folder, kind, chunk_hash, text, token_count, importance_weight, embedding_json, created_at, updated_at)
      VALUES (@id, @source_type, @source_id, @source_path, @scope, @group_folder, @kind, @chunk_hash, @text, @token_count, @importance_weight, @embedding_json, @created_at, @updated_at)`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memory_chunks_fts(id, text) VALUES (?, ?)`,
    );
    const insertVec = this.db.prepare(
      `INSERT INTO memory_chunks_vec(embedding) VALUES (?)`,
    );
    const insertVecMap = this.db.prepare(
      `INSERT INTO memory_chunk_vector_map(chunk_id, vec_rowid) VALUES (?, ?)`,
    );

    const txn = this.db.transaction((rows: ChunkInsert[]) => {
      let inserted = 0;
      for (const chunk of rows) {
        const chunkHash = MemoryStore.chunkHash(chunk);
        const id = MemoryStore.makeId('chunk');
        const tokenCount = Math.max(1, Math.ceil(chunk.text.length / 4));

        const result = insertChunk.run({
          id,
          source_type: chunk.source_type,
          source_id: chunk.source_id,
          source_path: chunk.source_path,
          scope: chunk.scope,
          group_folder: chunk.group_folder,
          kind: chunk.kind,
          chunk_hash: chunkHash,
          text: chunk.text,
          token_count: tokenCount,
          importance_weight: Math.max(0, chunk.importance_weight ?? 1),
          embedding_json: chunk.embedding
            ? JSON.stringify(chunk.embedding)
            : null,
          created_at: now,
          updated_at: now,
        });

        if (result.changes > 0) {
          insertFts.run(id, chunk.text);
          if (chunk.embedding) {
            const vecInsert = insertVec.run(JSON.stringify(chunk.embedding));
            insertVecMap.run(id, Number(vecInsert.lastInsertRowid));
          }
          inserted += 1;
        }
      }
      return inserted;
    });

    return txn(chunks);
  }

  lexicalSearch(
    query: string,
    groupFolder: string,
    limit: number,
  ): MemorySearchResult[] {
    const matchQuery = buildFtsMatchQuery(query);
    if (!matchQuery) return [];

    const rows = this.db
      .prepare(
        `SELECT c.id, c.source_type, c.source_path, c.text, c.scope, c.group_folder, c.created_at,
                bm25(memory_chunks_fts) AS lexical_score
         FROM memory_chunks_fts
         JOIN memory_chunks c ON c.id = memory_chunks_fts.id
         WHERE memory_chunks_fts MATCH @match_query
           AND (c.scope = 'global' OR c.group_folder = @group_folder)
         ORDER BY lexical_score ASC
         LIMIT @limit`,
      )
      .all({
        match_query: matchQuery,
        group_folder: groupFolder,
        limit,
      }) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      source_type: String(row.source_type),
      source_path: String(row.source_path),
      text: String(row.text),
      scope: row.scope as MemoryScope,
      group_folder: String(row.group_folder),
      created_at: String(row.created_at),
      lexical_score: Math.max(0, 1 / (1 + Number(row.lexical_score) || 1)),
      vector_score: 0,
      fused_score: 0,
    }));
  }

  vectorSearch(
    queryEmbedding: number[],
    groupFolder: string,
    limit: number,
  ): MemorySearchResult[] {
    const candidateLimit = Math.max(limit, Math.min(limit * 4, 200));

    const rows = this.db
      .prepare(
        `WITH nearest AS (
           SELECT rowid, distance
           FROM memory_chunks_vec
           WHERE embedding MATCH @embedding
             AND k = @candidate_limit
         )
         SELECT c.id, c.source_type, c.source_path, c.text, c.scope, c.group_folder, c.created_at, n.distance
         FROM nearest n
         JOIN memory_chunk_vector_map m ON m.vec_rowid = n.rowid
         JOIN memory_chunks c ON c.id = m.chunk_id
         WHERE c.id IS NOT NULL
           AND (c.scope = 'global' OR c.group_folder = @group_folder)
         ORDER BY n.distance ASC
         LIMIT @limit`,
      )
      .all({
        embedding: JSON.stringify(queryEmbedding),
        candidate_limit: candidateLimit,
        group_folder: groupFolder,
        limit,
      }) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const distance = Number(row.distance);
      const score = Number.isFinite(distance) ? 1 / (1 + distance) : 0;
      return {
        id: String(row.id),
        source_type: String(row.source_type),
        source_path: String(row.source_path),
        text: String(row.text),
        scope: row.scope as MemoryScope,
        group_folder: String(row.group_folder),
        created_at: String(row.created_at),
        lexical_score: 0,
        vector_score: score,
        fused_score: 0,
      };
    });
  }

  searchProceduresByText(
    query: string,
    groupFolder: string,
    limit: number,
  ): MemoryProcedure[] {
    const like = `%${query.replace(/[%_]/g, '')}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_procedures
         WHERE is_deleted = 0
           AND (scope = 'global' OR (scope = 'group' AND group_folder = @group_folder))
           AND (title LIKE @query OR body LIKE @query)
         ORDER BY confidence DESC, updated_at DESC
         LIMIT @limit`,
      )
      .all({ group_folder: groupFolder, query: like, limit }) as Record<
      string,
      unknown
    >[];

    return rows.map((row) => this.toProcedure(row));
  }

  listSourceChunks(sourceType: string, sourceId: string): MemoryChunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_chunks WHERE source_type = ? AND source_id = ?`,
      )
      .all(sourceType, sourceId) as Record<string, unknown>[];
    return rows.map((row) => this.toChunk(row));
  }

  applyRetentionPolicies(groupFolder: string): void {
    const maxChunksForScope =
      groupFolder === MEMORY_GLOBAL_GROUP_FOLDER
        ? MEMORY_MAX_GLOBAL_CHUNKS
        : MEMORY_MAX_CHUNKS_PER_GROUP;
    const cutoff = new Date(
      Date.now() - MEMORY_CHUNK_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const oldChunkIds = this.db
      .prepare(
        `SELECT id FROM memory_chunks
         WHERE group_folder = ?
           AND created_at < ?
         ORDER BY created_at ASC`,
      )
      .all(groupFolder, cutoff) as Array<{ id: string }>;

    if (oldChunkIds.length > 0) {
      this.deleteChunksByIds(oldChunkIds.map((row) => row.id));
    }

    const overflowChunks = this.db
      .prepare(
        `SELECT id FROM memory_chunks
         WHERE group_folder = ?
         ORDER BY importance_weight DESC, updated_at DESC
         LIMIT -1 OFFSET ?`,
      )
      .all(groupFolder, maxChunksForScope) as Array<{ id: string }>;

    if (overflowChunks.length > 0) {
      this.deleteChunksByIds(overflowChunks.map((row) => row.id));
    }

    const overflowItemIds = this.db
      .prepare(
        `SELECT id FROM memory_items
         WHERE is_deleted = 0
           AND group_folder = ?
           AND is_pinned = 0
         ORDER BY CASE WHEN confidence < ? THEN 0 ELSE 1 END ASC,
                  confidence ASC,
                  updated_at ASC
         LIMIT (
           SELECT MAX(0, COUNT(*) - ?)
           FROM memory_items
           WHERE is_deleted = 0
             AND group_folder = ?
         )`,
      )
      .all(
        groupFolder,
        MEMORY_RETENTION_PIN_THRESHOLD,
        MEMORY_ITEM_MAX_PER_GROUP,
        groupFolder,
      ) as Array<{ id: string }>;

    if (overflowItemIds.length > 0) {
      const now = new Date().toISOString();
      const markDeleted = this.db.prepare(
        `UPDATE memory_items
         SET is_deleted = 1,
             deleted_at = ?,
             updated_at = ?
         WHERE id = ?`,
      );
      const txn = this.db.transaction((rows: Array<{ id: string }>) => {
        for (const row of rows) {
          markDeleted.run(now, now, row.id);
        }
      });
      txn(overflowItemIds);
      this.deleteItemVectorsByIds(overflowItemIds.map((row) => row.id));
    }

    const overflowProcedures = this.db
      .prepare(
        `SELECT id FROM memory_procedures
         WHERE is_deleted = 0
           AND group_folder = ?
         ORDER BY confidence DESC, COALESCE(last_used_at, updated_at) DESC
         LIMIT -1 OFFSET ?`,
      )
      .all(groupFolder, MEMORY_MAX_PROCEDURES_PER_GROUP) as Array<{
      id: string;
    }>;

    if (overflowProcedures.length > 0) {
      const markDeleted = this.db.prepare(
        `UPDATE memory_procedures
         SET is_deleted = 1,
             deleted_at = ?,
             updated_at = ?
         WHERE id = ?`,
      );
      for (const row of overflowProcedures) {
        const now = new Date().toISOString();
        markDeleted.run(now, now, row.id);
      }
    }

    this.db.exec(`
      DELETE FROM memory_events
      WHERE id NOT IN (
        SELECT id FROM memory_events
        ORDER BY id DESC
        LIMIT ${MEMORY_MAX_EVENTS}
      );
    `);
  }

  recordEvent(
    eventType: string,
    entityType: string,
    entityId: string | null,
    payload: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_events(event_type, entity_type, entity_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        eventType,
        entityType,
        entityId,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }

  getLatestEvent(
    eventType: string,
    entityId?: string | null,
  ): {
    event_type: string;
    entity_type: string;
    entity_id: string | null;
    payload_json: string;
    created_at: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT event_type, entity_type, entity_id, payload_json, created_at
         FROM memory_events
         WHERE event_type = @event_type
           AND (@entity_id IS NULL OR entity_id = @entity_id)
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get({
        event_type: eventType,
        entity_id: entityId ?? null,
      }) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      event_type: String(row.event_type),
      entity_type: String(row.entity_type),
      entity_id: row.entity_id ? String(row.entity_id) : null,
      payload_json: String(row.payload_json || '{}'),
      created_at: String(row.created_at),
    };
  }

  private deleteChunksByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const deleteChunk = this.db.prepare(
      `DELETE FROM memory_chunks WHERE id = ?`,
    );
    const deleteFts = this.db.prepare(
      `DELETE FROM memory_chunks_fts WHERE id = ?`,
    );
    const findVecRow = this.db.prepare(
      `SELECT vec_rowid FROM memory_chunk_vector_map WHERE chunk_id = ?`,
    );
    const deleteVecMap = this.db.prepare(
      `DELETE FROM memory_chunk_vector_map WHERE chunk_id = ?`,
    );
    const deleteVec = this.db.prepare(
      `DELETE FROM memory_chunks_vec WHERE rowid = ?`,
    );

    const txn = this.db.transaction((chunkIds: string[]) => {
      for (const id of chunkIds) {
        const vecRow = findVecRow.get(id) as { vec_rowid?: number } | undefined;
        if (vecRow?.vec_rowid !== undefined) {
          deleteVec.run(vecRow.vec_rowid);
          deleteVecMap.run(id);
        }
        deleteFts.run(id);
        deleteChunk.run(id);
      }
    });

    txn(ids);
  }

  private deleteItemVectorsByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const findVecRow = this.db.prepare(
      `SELECT vec_rowid FROM memory_item_vector_map WHERE item_id = ?`,
    );
    const deleteVecMap = this.db.prepare(
      `DELETE FROM memory_item_vector_map WHERE item_id = ?`,
    );
    const deleteVec = this.db.prepare(
      `DELETE FROM memory_items_vec WHERE rowid = ?`,
    );

    const txn = this.db.transaction((itemIds: string[]) => {
      for (const id of itemIds) {
        const vecRow = findVecRow.get(id) as { vec_rowid?: number } | undefined;
        if (vecRow?.vec_rowid !== undefined) {
          deleteVec.run(vecRow.vec_rowid);
          deleteVecMap.run(id);
        }
      }
    });

    txn(ids);
  }

  private toItem(row: Record<string, unknown>): MemoryItem {
    return {
      id: String(row.id),
      scope: row.scope as MemoryScope,
      group_folder: String(row.group_folder),
      user_id: row.user_id ? String(row.user_id) : null,
      kind: row.kind as MemoryItem['kind'],
      key: String(row.key),
      value: String(row.value),
      why: row.why ? String(row.why) : undefined,
      load_bearing: Number(row.load_bearing || 0) === 1,
      source_turn_id: row.source_turn_id ? String(row.source_turn_id) : null,
      source: String(row.source),
      confidence: Number(row.confidence),
      is_pinned: Number(row.is_pinned || 0) === 1,
      used_count: Number(row.used_count || 0),
      superseded_by: row.superseded_by ? String(row.superseded_by) : null,
      is_deleted: Number(row.is_deleted || 0) === 1,
      deleted_at: row.deleted_at ? String(row.deleted_at) : null,
      last_reviewed_at: row.last_reviewed_at
        ? String(row.last_reviewed_at)
        : null,
      version: Number(row.version),
      last_used_at: row.last_used_at ? String(row.last_used_at) : null,
      last_retrieved_at: row.last_retrieved_at
        ? String(row.last_retrieved_at)
        : null,
      retrieval_count: Number(row.retrieval_count || 0),
      total_score: Number(row.total_score || 0),
      max_score: Number(row.max_score || 0),
      query_hashes_json: String(row.query_hashes_json || '[]'),
      recall_days_json: String(row.recall_days_json || '[]'),
      embedding_json: row.embedding_json ? String(row.embedding_json) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private parseStringArray(value: unknown): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(String(value)) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private toProcedure(row: Record<string, unknown>): MemoryProcedure {
    return {
      id: String(row.id),
      scope: row.scope as MemoryScope,
      group_folder: String(row.group_folder),
      title: String(row.title),
      body: String(row.body),
      tags: JSON.parse(String(row.tags_json || '[]')) as string[],
      origin:
        row.origin === 'accepted_suggestion'
          ? 'accepted_suggestion'
          : 'explicit',
      trigger: row.trigger ? String(row.trigger) : null,
      source: String(row.source),
      confidence: Number(row.confidence),
      is_deleted: Number(row.is_deleted || 0) === 1,
      deleted_at: row.deleted_at ? String(row.deleted_at) : null,
      version: Number(row.version),
      last_used_at: row.last_used_at ? String(row.last_used_at) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private toChunk(row: Record<string, unknown>): MemoryChunk {
    return {
      id: String(row.id),
      source_type: String(row.source_type),
      source_id: String(row.source_id),
      source_path: String(row.source_path),
      scope: row.scope as MemoryScope,
      group_folder: String(row.group_folder),
      kind: String(row.kind),
      chunk_hash: String(row.chunk_hash),
      text: String(row.text),
      token_count: Number(row.token_count),
      importance_weight: Number(row.importance_weight || 1),
      embedding_json: row.embedding_json ? String(row.embedding_json) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }
}
