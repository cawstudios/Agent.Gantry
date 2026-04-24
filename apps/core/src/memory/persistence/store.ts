/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import { getRuntimeStorage } from '../../infrastructure/postgres/runtime-store.js';
import type { PostgresStorageService } from '../../infrastructure/postgres/storage-service.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../../infrastructure/postgres/schema/schema.js';
import type { MemoryScope } from '../memory-types.js';
import { chunkHash, makeId } from './store-utils.js';
import * as chunkOps from './store-chunks.js';
import * as embeddingOps from './store-embeddings.js';
import * as eventRetentionOps from './store-retention-events.js';
import * as itemOps from './store-items.js';
import * as procedureOps from './store-procedures.js';
import * as usageOps from './store-usage.js';

export interface ChunkInsert {
  source_type: string;
  source_id: string;
  source_path: string;
  scope: MemoryScope;
  group_folder: string;
  topic_id?: string | null;
  kind: string;
  text: string;
  importance_weight?: number;
  embedding: number[] | null;
}

export interface RetentionPolicyResult {
  removedItemIds: string[];
  removedProcedureIds: string[];
  evictedChunkIds: string[];
}

type Db = NodePgDatabase<typeof pgSchema>;

export class MemoryStore {
  private readonly explicitDb: Db | null;

  constructor(db?: Db | string) {
    this.explicitDb = typeof db === 'object' ? db : null;
  }

  get db(): Db {
    if (this.explicitDb) return this.explicitDb;
    return (getRuntimeStorage().service as PostgresStorageService).db;
  }

  close(): void {}

  async runHealthChecks(): Promise<void> {
    await this.db
      .select({ id: pgSchema.memoryEventsPostgres.id })
      .from(pgSchema.memoryEventsPostgres)
      .limit(1);
  }

  static makeId(prefix: string): string {
    return makeId(prefix);
  }

  static chunkHash(input: ChunkInsert): string {
    return chunkHash(input);
  }
}

type BoundStoreMethods<T> = {
  [K in keyof T]: T[K] extends (
    this: MemoryStore,
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Result
    : T[K];
};

type ItemStoreMethods = BoundStoreMethods<typeof itemOps>;
type EmbeddingStoreMethods = BoundStoreMethods<typeof embeddingOps>;
type UsageStoreMethods = BoundStoreMethods<typeof usageOps>;
type ProcedureStoreMethods = BoundStoreMethods<typeof procedureOps>;
type ChunkStoreMethods = BoundStoreMethods<typeof chunkOps>;
type EventRetentionStoreMethods = BoundStoreMethods<typeof eventRetentionOps>;

export interface MemoryStore
  extends
    ItemStoreMethods,
    EmbeddingStoreMethods,
    UsageStoreMethods,
    ProcedureStoreMethods,
    ChunkStoreMethods,
    EventRetentionStoreMethods {}

Object.assign(
  MemoryStore.prototype,
  itemOps,
  embeddingOps,
  usageOps,
  procedureOps,
  chunkOps,
  eventRetentionOps,
);