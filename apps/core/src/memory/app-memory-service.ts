import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, or, sql } from 'drizzle-orm';
import { cosineDistance } from 'drizzle-orm/sql/functions';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { RUNTIME_MEMORY_ENABLED } from '../config/memory-state.js';
import { getRuntimeStorage } from '../infrastructure/postgres/runtime-store.js';
import type { PostgresStorageService } from '../infrastructure/postgres/storage-service.js';
import * as pgSchema from '../infrastructure/postgres/schema/schema.js';
import { classifySensitiveMemoryMaterial } from './sensitive-material.js';
import { createEmbeddingProvider } from './memory-embeddings.js';
import { runAppMemoryDreamPass } from './app-memory-dreaming.js';
import {
  normalizeSubject,
  toLegacyScope,
  visibleSubjectFilters,
} from './app-memory-boundaries.js';
import type {
  AppMemoryItem,
  AppMemorySearchInput,
  AppMemorySearchResult,
  DeleteAppMemoryInput,
  DreamingRunStatus,
  DreamingTriggerInput,
  MemoryBoundaryContext,
  MemoryEvidenceRecord,
  MemoryKind,
  MemorySubjectType,
  NormalizedMemorySubject,
  PatchAppMemoryInput,
  SaveAppMemoryInput,
} from './memory-types.js';

type Db = NodePgDatabase<typeof pgSchema>;
type MemoryItemRow = typeof pgSchema.memoryItemsPostgres.$inferSelect;
type MemoryEvidenceRow = typeof pgSchema.memoryEvidencePostgres.$inferSelect;
type MemoryDreamRunRow = typeof pgSchema.memoryDreamRunsPostgres.$inferSelect;

function nowIso(): string {
  return new Date().toISOString();
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function clampConfidence(value: number | undefined, fallback = 0.7): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeKind(value: string | undefined): MemoryKind {
  const allowed = new Set<MemoryKind>([
    'preference',
    'decision',
    'fact',
    'correction',
    'constraint',
    'project_fact',
    'reference',
  ]);
  return allowed.has(value as MemoryKind) ? (value as MemoryKind) : 'fact';
}

function toAppItem(row: MemoryItemRow): AppMemoryItem {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    ...(row.userIdCanonical ? { userId: row.userIdCanonical } : {}),
    ...(row.groupIdCanonical ? { groupId: row.groupIdCanonical } : {}),
    ...(row.channelIdCanonical ? { channelId: row.channelIdCanonical } : {}),
    ...(row.threadIdCanonical ? { threadId: row.threadIdCanonical } : {}),
    kind: row.kind as MemoryKind,
    key: row.key,
    value: row.value,
    why: row.why,
    confidence: row.confidence,
    isPinned: row.isPinned,
    version: row.version,
    source: row.source,
    evidenceIds: parseJsonArray(row.evidenceIdsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEvidence(row: MemoryEvidenceRow): MemoryEvidenceRecord {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    ...(row.userId ? { userId: row.userId } : {}),
    ...(row.groupId ? { groupId: row.groupId } : {}),
    ...(row.channelId ? { channelId: row.channelId } : {}),
    ...(row.threadId ? { threadId: row.threadId } : {}),
    sourceType: row.sourceType as MemoryEvidenceRecord['sourceType'],
    sourceId: row.sourceId,
    actorId: row.actorId,
    text: row.text,
    metadata: parseJsonObject(row.metadataJson),
    createdAt: row.createdAt,
  };
}

function toRun(row: MemoryDreamRunRow): DreamingRunStatus {
  return {
    runId: row.id,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    phase: row.phase as DreamingRunStatus['phase'],
    status: row.status as DreamingRunStatus['status'],
    summary: parseJsonObject(row.summaryJson),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function itemMatchesSubjectBoundary(
  row: Pick<
    MemoryItemRow,
    'appId' | 'agentId' | 'subjectType' | 'subjectId' | 'threadIdCanonical'
  >,
  context: NormalizedMemorySubject,
): boolean {
  if (row.appId !== context.appId) return false;
  if (row.agentId !== context.agentId) return false;
  if (row.subjectType !== context.subjectType) return false;
  if (row.subjectId !== context.subjectId) return false;
  if (context.threadId) {
    return (
      row.threadIdCanonical === null ||
      row.threadIdCanonical === context.threadId
    );
  }
  return row.threadIdCanonical === null;
}

function sqlThreadVisibilityFilter(
  column: typeof pgSchema.memoryItemsPostgres.threadIdCanonical,
  threadId: string | undefined,
) {
  return threadId
    ? or(eq(column, threadId), sql`${column} IS NULL`)
    : sql`${column} IS NULL`;
}

function sqlThreadIdentityFilter(
  column: typeof pgSchema.memoryItemsPostgres.threadIdCanonical,
  threadId: string | undefined,
) {
  return threadId ? eq(column, threadId) : sql`${column} IS NULL`;
}

export class AppMemoryService {
  private static singleton: AppMemoryService | null = null;

  static getInstance(): AppMemoryService {
    AppMemoryService.singleton ??= new AppMemoryService();
    return AppMemoryService.singleton;
  }

  static resetForTest(): void {
    AppMemoryService.singleton = null;
  }

  private readonly explicitDb: Db | null;

  constructor(db?: Db) {
    this.explicitDb = db ?? null;
  }

  get db(): Db {
    if (this.explicitDb) return this.explicitDb;
    return (getRuntimeStorage().service as PostgresStorageService).db;
  }

  isEnabled(): boolean {
    return RUNTIME_MEMORY_ENABLED;
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new Error('memory is disabled in runtime settings');
    }
  }

  async recordEvidence(
    input: Partial<MemoryBoundaryContext> & {
      subjectType?: MemorySubjectType;
      subjectId?: string;
      sourceType: MemoryEvidenceRecord['sourceType'];
      sourceId?: string;
      actorId?: string;
      text: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<MemoryEvidenceRecord> {
    this.assertEnabled();
    const subject = normalizeSubject(input);
    const text = input.text.trim();
    if (!text) throw new Error('memory evidence text is required');
    const sensitiveReason = classifySensitiveMemoryMaterial(text);
    if (sensitiveReason) {
      throw new Error(
        `sensitive material blocked in memory evidence: ${sensitiveReason}`,
      );
    }
    const row = {
      id: `mev_${randomUUID().replace(/-/g, '')}`,
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      userId: subject.userId ?? null,
      groupId: subject.groupId ?? null,
      channelId: subject.channelId ?? null,
      threadId: subject.threadId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      actorId: input.actorId ?? null,
      text,
      metadataJson: JSON.stringify(input.metadata || {}),
      createdAt: nowIso(),
    } satisfies typeof pgSchema.memoryEvidencePostgres.$inferInsert;
    const [saved] = await this.db
      .insert(pgSchema.memoryEvidencePostgres)
      .values(row)
      .returning();
    return toEvidence(saved!);
  }

  async save(input: SaveAppMemoryInput): Promise<AppMemoryItem> {
    this.assertEnabled();
    const subject = normalizeSubject(input);
    if (subject.subjectType === 'common' && !input.isAdminWrite) {
      throw new Error('common memory writes require admin/service authority');
    }
    for (const [field, value] of [
      ['key', input.key],
      ['value', input.value],
      ['why', input.why || ''],
    ] as const) {
      const reason = classifySensitiveMemoryMaterial(value);
      if (reason) {
        throw new Error(
          `sensitive material blocked in memory ${field}: ${reason}`,
        );
      }
    }
    const evidenceIds = [...(input.evidenceIds || [])];
    if (input.evidenceText?.trim()) {
      const evidence = await this.recordEvidence({
        ...subject,
        sourceType: 'manual',
        sourceId: input.source,
        actorId: input.actorId,
        text: input.evidenceText,
      });
      evidenceIds.push(evidence.id);
    }
    const now = nowIso();
    const existing = await this.findActiveByKey(subject, input.key);
    const nextEvidenceIds = Array.from(
      new Set([
        ...(existing ? parseJsonArray(existing.evidenceIdsJson) : []),
        ...evidenceIds,
      ]),
    );
    const base = {
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      userIdCanonical: subject.userId ?? null,
      groupIdCanonical: subject.groupId ?? null,
      channelIdCanonical: subject.channelId ?? null,
      threadIdCanonical: subject.threadId ?? null,
      scope: toLegacyScope(subject.subjectType),
      groupFolder: subject.groupId || subject.agentId,
      userId: subject.userId ?? null,
      topicId: subject.threadId ?? null,
      kind: normalizeKind(input.kind),
      key: input.key.trim(),
      value: input.value.trim(),
      why: input.why?.trim() || null,
      loadBearing: subject.subjectType === 'common',
      evidenceIdsJson: JSON.stringify(nextEvidenceIds),
      source: input.source || 'sdk',
      sourceFolder: 'postgres',
      filePath: '',
      contentHash: hashText(
        `${subject.appId}:${subject.agentId}:${subject.subjectType}:${subject.subjectId}:${input.key}:${input.value}`,
      ),
      confidence: clampConfidence(input.confidence),
      updatedAt: now,
    };
    if (existing) {
      const [updated] = await this.db
        .update(pgSchema.memoryItemsPostgres)
        .set({
          ...base,
          version: existing.version + 1,
        })
        .where(eq(pgSchema.memoryItemsPostgres.id, existing.id))
        .returning();
      return toAppItem(updated!);
    }
    const [created] = await this.db
      .insert(pgSchema.memoryItemsPostgres)
      .values({
        id: `mem_${randomUUID().replace(/-/g, '')}`,
        ...base,
        createdAt: now,
        isPinned: false,
      })
      .returning();
    await this.ensureSubject(subject);
    return toAppItem(created!);
  }

  async list(input: AppMemorySearchInput = {}): Promise<AppMemoryItem[]> {
    if (!this.isEnabled()) return [];
    const rows = await this.queryItems(input, false);
    return rows.map((row) => toAppItem(row.row));
  }

  async search(
    input: AppMemorySearchInput = {},
  ): Promise<AppMemorySearchResult[]> {
    if (!this.isEnabled()) return [];
    const rows = await this.queryItems(input, true);
    const results = rows.map((row) => ({
      item: toAppItem(row.row),
      score: row.score,
      lexicalScore: row.lexicalScore,
      vectorScore: row.vectorScore,
      reasons: row.reasons,
    }));
    await this.recordRecallEvents(input, results);
    return results;
  }

  async patch(input: PatchAppMemoryInput): Promise<AppMemoryItem> {
    this.assertEnabled();
    const current = await this.getOwnedItem(input);
    if (!current) throw new Error('memory item not found');
    if (current.subjectType === 'common' && !input.isAdminWrite) {
      throw new Error('common memory patches require admin/service authority');
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== current.version
    ) {
      throw new Error('stale memory patch');
    }
    for (const value of [input.key, input.value, input.why || undefined]) {
      if (!value) continue;
      const reason = classifySensitiveMemoryMaterial(value);
      if (reason)
        throw new Error(
          `sensitive material blocked in memory patch: ${reason}`,
        );
    }
    const [row] = await this.db
      .update(pgSchema.memoryItemsPostgres)
      .set({
        ...(input.key !== undefined ? { key: input.key.trim() } : {}),
        ...(input.value !== undefined ? { value: input.value.trim() } : {}),
        ...(input.why !== undefined ? { why: input.why?.trim() || null } : {}),
        ...(input.confidence !== undefined
          ? { confidence: clampConfidence(input.confidence) }
          : {}),
        ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
        version: current.version + 1,
        updatedAt: nowIso(),
      })
      .where(eq(pgSchema.memoryItemsPostgres.id, current.id))
      .returning();
    return toAppItem(row!);
  }

  async delete(input: DeleteAppMemoryInput): Promise<{ deleted: boolean }> {
    this.assertEnabled();
    const current = await this.getOwnedItem(input);
    if (!current) return { deleted: false };
    if (current.subjectType === 'common' && !input.isAdminWrite) {
      throw new Error('common memory deletes require admin/service authority');
    }
    await this.db
      .update(pgSchema.memoryItemsPostgres)
      .set({ isDeleted: true, deletedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(pgSchema.memoryItemsPostgres.id, current.id));
    return { deleted: true };
  }

  async triggerDreaming(
    input: DreamingTriggerInput = {},
  ): Promise<DreamingRunStatus> {
    this.assertEnabled();
    const subject = normalizeSubject(input);
    const phase = input.phase || 'all';
    const now = nowIso();
    const runId = `mdr_${randomUUID().replace(/-/g, '')}`;
    await this.db.insert(pgSchema.memoryDreamRunsPostgres).values({
      id: runId,
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      phase,
      status: 'running',
      summaryJson: '{}',
      startedAt: now,
    });
    const decisions = await runAppMemoryDreamPass({
      db: this.db,
      runId,
      subject,
      phase,
      dryRun: Boolean(input.dryRun),
      listItems: () => this.queryItems({ ...subject, limit: 100 }, false),
      save: (value) => this.save(value),
    });
    const completedAt = nowIso();
    const summary = {
      decisions: decisions.length,
      promoted: decisions.filter((decision) => decision.action === 'promote')
        .length,
      needsReview: decisions.filter(
        (decision) => decision.action === 'needs_review',
      ).length,
      dryRun: Boolean(input.dryRun),
    };
    const [row] = await this.db
      .update(pgSchema.memoryDreamRunsPostgres)
      .set({
        status: 'completed',
        summaryJson: JSON.stringify(summary),
        completedAt,
      })
      .where(eq(pgSchema.memoryDreamRunsPostgres.id, runId))
      .returning();
    return toRun(row!);
  }

  async dreamingStatus(
    input: Partial<MemoryBoundaryContext> = {},
  ): Promise<DreamingRunStatus[]> {
    if (!this.isEnabled()) return [];
    const subject = normalizeSubject(input);
    const rows = await this.db
      .select()
      .from(pgSchema.memoryDreamRunsPostgres)
      .where(
        and(
          eq(pgSchema.memoryDreamRunsPostgres.appId, subject.appId),
          eq(pgSchema.memoryDreamRunsPostgres.agentId, subject.agentId),
        ),
      )
      .orderBy(desc(pgSchema.memoryDreamRunsPostgres.startedAt))
      .limit(20);
    return rows.map(toRun);
  }

  private async ensureSubject(subject: NormalizedMemorySubject): Promise<void> {
    const now = nowIso();
    await this.db
      .insert(pgSchema.memorySubjectsPostgres)
      .values({
        id: `msu_${hashText(`${subject.appId}:${subject.agentId}:${subject.subjectType}:${subject.subjectId}`).slice(0, 32)}`,
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        externalId: subject.subjectId,
        label: subject.subjectId,
        metadataJson: JSON.stringify({
          userId: subject.userId,
          groupId: subject.groupId,
          channelId: subject.channelId,
          threadId: subject.threadId,
        }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          pgSchema.memorySubjectsPostgres.appId,
          pgSchema.memorySubjectsPostgres.agentId,
          pgSchema.memorySubjectsPostgres.subjectType,
          pgSchema.memorySubjectsPostgres.subjectId,
        ],
        set: { updatedAt: now },
      });
  }

  private async findActiveByKey(
    subject: NormalizedMemorySubject,
    key: string,
  ): Promise<MemoryItemRow | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.isDeleted, false),
          eq(pgSchema.memoryItemsPostgres.appId, subject.appId),
          eq(pgSchema.memoryItemsPostgres.agentId, subject.agentId),
          eq(pgSchema.memoryItemsPostgres.subjectType, subject.subjectType),
          eq(pgSchema.memoryItemsPostgres.subjectId, subject.subjectId),
          sqlThreadIdentityFilter(
            pgSchema.memoryItemsPostgres.threadIdCanonical,
            subject.threadId,
          ),
          eq(pgSchema.memoryItemsPostgres.key, key.trim()),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async getOwnedItem(
    input: { id: string } & Partial<MemoryBoundaryContext>,
  ): Promise<MemoryItemRow | null> {
    const context = normalizeSubject(input);
    const rows = await this.db
      .select()
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.id, input.id),
          eq(pgSchema.memoryItemsPostgres.isDeleted, false),
          eq(pgSchema.memoryItemsPostgres.appId, context.appId),
          eq(pgSchema.memoryItemsPostgres.agentId, context.agentId),
        ),
      )
      .limit(1);
    const row = rows[0] ?? null;
    return row && itemMatchesSubjectBoundary(row, context) ? row : null;
  }

  private async queryItems(
    input: AppMemorySearchInput,
    ranked: boolean,
  ): Promise<
    Array<{
      row: MemoryItemRow;
      score: number;
      lexicalScore: number;
      vectorScore: number;
      reasons: string[];
    }>
  > {
    const context = normalizeSubject(input);
    const query = input.query?.trim() || '';
    const i = pgSchema.memoryItemsPostgres;
    const document = sql`to_tsvector('english', ${i.key} || ' ' || ${i.value} || ' ' || COALESCE(${i.why}, ''))`;
    const searchQuery = sql`plainto_tsquery('english', ${query})`;
    const lexicalScore = query
      ? sql<number>`ts_rank_cd(${document}, ${searchQuery})`
      : sql<number>`0`;
    const visible = visibleSubjectFilters(i, input);
    const threadFilter = sqlThreadVisibilityFilter(
      i.threadIdCanonical,
      context.threadId,
    );
    const embedding = await this.maybeEmbedQuery(query);
    const vectorScore =
      embedding && ranked
        ? sql<number>`CASE WHEN ${i.embedding} IS NULL THEN 0 ELSE 1 - ${cosineDistance(i.embedding, embedding)} END`
        : sql<number>`0`;
    const combinedScore = sql<number>`(${lexicalScore} * 0.65) + (${vectorScore} * 0.35) + (${i.confidence} * 0.10)`;
    const rows = await this.db
      .select({
        row: i,
        lexicalScore,
        vectorScore,
        score: ranked ? combinedScore : sql<number>`${i.confidence}`,
      })
      .from(i)
      .where(
        and(
          eq(i.isDeleted, false),
          eq(i.appId, context.appId),
          eq(i.agentId, context.agentId),
          visible.length === 0
            ? sql`false`
            : visible.length === 1
              ? visible[0]
              : or(...visible),
          threadFilter,
          query
            ? embedding
              ? or(
                  sql`${document} @@ ${searchQuery}`,
                  sql`${i.embedding} IS NOT NULL`,
                )
              : sql`${document} @@ ${searchQuery}`
            : undefined,
        ),
      )
      .orderBy(ranked ? desc(combinedScore) : desc(i.updatedAt))
      .limit(Math.max(1, Math.min(input.limit || 20, 100)));
    return rows.map((row) => ({
      row: row.row,
      score: Number(row.score || 0),
      lexicalScore: Number(row.lexicalScore || 0),
      vectorScore: Number(row.vectorScore || 0),
      reasons: [
        row.lexicalScore ? 'lexical' : '',
        row.vectorScore ? 'semantic' : '',
        row.row.isPinned ? 'pinned' : '',
      ].filter(Boolean),
    }));
  }

  private async maybeEmbedQuery(query: string): Promise<number[] | null> {
    if (!query) return null;
    const embeddings = createEmbeddingProvider();
    if (!embeddings.isEnabled()) return null;
    return embeddings.embedOne(query);
  }

  private async recordRecallEvents(
    input: AppMemorySearchInput,
    results: AppMemorySearchResult[],
  ): Promise<void> {
    if (results.length === 0) return;
    const context = normalizeSubject(input);
    const queryHash = hashText(input.query || '');
    const createdAt = nowIso();
    await this.db.insert(pgSchema.memoryRecallEventsPostgres).values(
      results.map((result) => ({
        appId: context.appId,
        agentId: context.agentId,
        itemId: result.item.id,
        queryHash,
        score: result.score,
        subjectJson: JSON.stringify(context),
        createdAt,
      })),
    );
    await Promise.all(
      results.map((result) =>
        this.db
          .update(pgSchema.memoryItemsPostgres)
          .set({
            lastRetrievedAt: createdAt,
            retrievalCount: sql`${pgSchema.memoryItemsPostgres.retrievalCount} + 1`,
            totalScore: sql`${pgSchema.memoryItemsPostgres.totalScore} + ${result.score}`,
            maxScore: sql`GREATEST(${pgSchema.memoryItemsPostgres.maxScore}, ${result.score})`,
          })
          .where(eq(pgSchema.memoryItemsPostgres.id, result.item.id)),
      ),
    );
  }
}

export const _testAppMemory = {
  itemMatchesSubjectBoundary,
  sqlThreadIdentityFilter,
  sqlThreadVisibilityFilter,
  normalizeSubject,
  visibleSubjectFilters,
};
