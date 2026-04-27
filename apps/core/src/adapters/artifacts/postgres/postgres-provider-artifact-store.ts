import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import type { ProviderArtifactStore } from '../../../domain/ports/provider-artifact-store.js';
import type {
  ProviderSessionArtifact,
  ProviderSessionArtifactId,
  ProviderSessionArtifactKind,
  ProviderSessionArtifactStorageType,
} from '../../../domain/sessions/provider-session-artifact.js';
import * as pgSchema from '../../storage/postgres/schema/schema.js';
import type { CanonicalDb } from '../../storage/postgres/repositories/canonical-graph-repository.postgres.js';

type ArtifactRow =
  typeof pgSchema.providerSessionArtifactsPostgres.$inferSelect;

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return fallback;
  }
}

function bytesFor(content: Uint8Array | string): Buffer {
  return typeof content === 'string'
    ? Buffer.from(content, 'utf-8')
    : Buffer.from(content);
}

function sha256(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function sanitizeSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180);
  return safe || 'unknown';
}

function artifactExtension(kind: ProviderSessionArtifactKind): string {
  switch (kind) {
    case 'claude-jsonl':
      return '.jsonl';
    case 'claude-session-index':
    case 'provider-state':
      return '.json';
    case 'transcript-export':
      return '.md';
  }
}

function ensureWithinBase(baseDir: string, candidatePath: string): void {
  const relative = path.relative(baseDir, candidatePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Provider artifact path escapes artifact root: ${candidatePath}`,
    );
  }
}

function writeFileAtomic(filePath: string, content: Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function removeFileIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function shouldReturnString(artifact: ProviderSessionArtifact): boolean {
  const contentType =
    typeof artifact.metadata.contentType === 'string'
      ? artifact.metadata.contentType
      : '';
  return (
    artifact.metadata.contentEncoding === 'utf8' ||
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('markdown')
  );
}

export interface PostgresProviderArtifactStoreOptions {
  artifactRoot: string;
  defaultStorageType?: ProviderSessionArtifactStorageType;
}

export class PostgresProviderArtifactStore implements ProviderArtifactStore {
  private readonly artifactRoot: string;
  private readonly defaultStorageType: ProviderSessionArtifactStorageType;

  constructor(
    private readonly db: CanonicalDb,
    options: PostgresProviderArtifactStoreOptions,
  ) {
    this.artifactRoot = path.resolve(options.artifactRoot);
    this.defaultStorageType = options.defaultStorageType ?? 'local-filesystem';
  }

  async putArtifact(input: {
    id?: ProviderSessionArtifactId;
    appId: ProviderSessionArtifact['appId'];
    agentId: ProviderSessionArtifact['agentId'];
    agentSessionId: ProviderSessionArtifact['agentSessionId'];
    providerSessionId: ProviderSessionArtifact['providerSessionId'];
    provider: string;
    artifactKind: ProviderSessionArtifactKind;
    storageType?: ProviderSessionArtifactStorageType;
    content: Uint8Array | string;
    contentType?: string;
    createdAt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProviderSessionArtifact> {
    const content = bytesFor(input.content);
    const id =
      input.id ??
      (`provider-session-artifact:${randomUUID()}` as ProviderSessionArtifactId);
    const storageType = input.storageType ?? this.defaultStorageType;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const contentHash = sha256(content);
    const metadata = {
      ...(input.metadata ?? {}),
      contentType:
        input.contentType ??
        input.metadata?.contentType ??
        'application/octet-stream',
      contentEncoding:
        typeof input.content === 'string'
          ? 'utf8'
          : input.metadata?.contentEncoding,
    };
    const storageRef = this.resolveStorageRef({
      id,
      appId: input.appId,
      agentId: input.agentId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      artifactKind: input.artifactKind,
      storageType,
    });

    const artifactPath =
      storageType === 'local-filesystem'
        ? this.resolveLocalPath(storageRef)
        : undefined;
    if (storageType === 'local-filesystem' && artifactPath) {
      writeFileAtomic(artifactPath, content);
    } else if (storageType === 'object-store') {
      throw new Error(
        'object-store provider artifacts require an object-store adapter',
      );
    }

    const contentText =
      storageType === 'postgres' ? content.toString('utf-8') : null;
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .select({ id: pgSchema.providerSessionsPostgres.id })
          .from(pgSchema.providerSessionsPostgres)
          .where(
            eq(pgSchema.providerSessionsPostgres.id, input.providerSessionId),
          )
          .for('update')
          .limit(1);
        await tx.insert(pgSchema.providerSessionArtifactsPostgres).values({
          id,
          appId: input.appId,
          agentId: input.agentId,
          agentSessionId: input.agentSessionId,
          providerSessionId: input.providerSessionId,
          provider: input.provider,
          artifactKind: input.artifactKind,
          storageType,
          storageRef,
          contentHash,
          sizeBytes: content.byteLength,
          contentText,
          metadataJson: encodeJson(metadata),
          createdAt,
        });
        await tx
          .update(pgSchema.providerSessionsPostgres)
          .set({
            latestArtifactId: sql`(
              SELECT ${pgSchema.providerSessionArtifactsPostgres.id}
              FROM ${pgSchema.providerSessionArtifactsPostgres}
              WHERE ${pgSchema.providerSessionArtifactsPostgres.providerSessionId} = ${input.providerSessionId}
                AND ${pgSchema.providerSessionArtifactsPostgres.deletedAt} IS NULL
              ORDER BY ${pgSchema.providerSessionArtifactsPostgres.createdAt} DESC,
                       ${pgSchema.providerSessionArtifactsPostgres.id} DESC
              LIMIT 1
            )`,
            updatedAt: sql`now()`,
          })
          .where(
            eq(pgSchema.providerSessionsPostgres.id, input.providerSessionId),
          );
      });
    } catch (err) {
      if (artifactPath) removeFileIfExists(artifactPath);
      throw err;
    }

    return {
      id,
      appId: input.appId,
      agentId: input.agentId,
      agentSessionId: input.agentSessionId,
      providerSessionId: input.providerSessionId,
      provider: input.provider,
      artifactKind: input.artifactKind,
      storageType,
      storageRef,
      contentHash,
      sizeBytes: content.byteLength,
      createdAt,
      metadata,
    };
  }

  async getArtifact(
    ref: ProviderSessionArtifactId | ProviderSessionArtifact,
  ): Promise<Uint8Array | string> {
    const artifact =
      typeof ref === 'string' ? await this.getArtifactMetadata(ref) : ref;
    if (!artifact || artifact.deletedAt) {
      throw new Error('Provider artifact not found');
    }

    let content: Buffer;
    if (artifact.storageType === 'postgres') {
      const row = await this.getRow(artifact.id);
      if (!row?.contentText)
        throw new Error('Provider artifact content not found');
      content = Buffer.from(row.contentText, 'utf-8');
    } else if (artifact.storageType === 'local-filesystem') {
      content = fs.readFileSync(this.resolveLocalPath(artifact.storageRef));
    } else {
      throw new Error(
        'object-store provider artifacts require an object-store adapter',
      );
    }

    this.verifyContent(artifact, content);
    return shouldReturnString(artifact) ? content.toString('utf-8') : content;
  }

  async getLatestArtifact(input: {
    agentSessionId?: ProviderSessionArtifact['agentSessionId'];
    providerSessionId?: ProviderSessionArtifact['providerSessionId'];
    provider?: string;
    artifactKind?: ProviderSessionArtifactKind;
  }): Promise<ProviderSessionArtifact | undefined> {
    const rows = await this.queryRows(input, 1);
    return rows[0] ? this.fromRow(rows[0]) : undefined;
  }

  async listArtifacts(input: {
    appId?: ProviderSessionArtifact['appId'];
    agentId?: ProviderSessionArtifact['agentId'];
    agentSessionId?: ProviderSessionArtifact['agentSessionId'];
    providerSessionId?: ProviderSessionArtifact['providerSessionId'];
    provider?: string;
    artifactKind?: ProviderSessionArtifactKind;
    includeDeleted?: boolean;
    limit?: number;
  }): Promise<ProviderSessionArtifact[]> {
    const rows = await this.queryRows(input, input.limit ?? 100);
    return rows.map((row) => this.fromRow(row));
  }

  async markDeleted(
    ref: ProviderSessionArtifactId | ProviderSessionArtifact,
    deletedAt = new Date().toISOString(),
  ): Promise<void> {
    const id = typeof ref === 'string' ? ref : ref.id;
    await this.db
      .update(pgSchema.providerSessionArtifactsPostgres)
      .set({ deletedAt })
      .where(eq(pgSchema.providerSessionArtifactsPostgres.id, id));
  }

  async healthCheck(): Promise<void> {
    await this.db.execute(sql`SELECT 1`);
    if (this.defaultStorageType === 'local-filesystem') {
      fs.mkdirSync(this.artifactRoot, { recursive: true, mode: 0o700 });
      fs.accessSync(this.artifactRoot, fs.constants.R_OK | fs.constants.W_OK);
    }
  }

  private resolveStorageRef(input: {
    id: ProviderSessionArtifactId;
    appId: string;
    agentId: string;
    provider: string;
    providerSessionId: string;
    artifactKind: ProviderSessionArtifactKind;
    storageType: ProviderSessionArtifactStorageType;
  }): string {
    if (input.storageType === 'postgres') return input.id;
    if (input.storageType === 'object-store') {
      return [
        'provider-sessions',
        sanitizeSegment(input.appId),
        sanitizeSegment(input.agentId),
        sanitizeSegment(input.provider),
        sanitizeSegment(input.providerSessionId),
        `${sanitizeSegment(input.id)}${artifactExtension(input.artifactKind)}`,
      ].join('/');
    }
    return path.join(
      'provider-sessions',
      `app_${sanitizeSegment(input.appId)}`,
      `agent_${sanitizeSegment(input.agentId)}`,
      `provider_${sanitizeSegment(input.provider)}`,
      `session_${sanitizeSegment(input.providerSessionId)}`,
      `${sanitizeSegment(input.id)}${artifactExtension(input.artifactKind)}`,
    );
  }

  private resolveLocalPath(storageRef: string): string {
    const resolved = path.resolve(this.artifactRoot, storageRef);
    ensureWithinBase(this.artifactRoot, resolved);
    return resolved;
  }

  private async getArtifactMetadata(
    id: ProviderSessionArtifactId,
  ): Promise<ProviderSessionArtifact | undefined> {
    const row = await this.getRow(id);
    return row ? this.fromRow(row) : undefined;
  }

  private async getRow(
    id: ProviderSessionArtifactId,
  ): Promise<ArtifactRow | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.providerSessionArtifactsPostgres)
      .where(eq(pgSchema.providerSessionArtifactsPostgres.id, id))
      .limit(1);
    return rows[0];
  }

  private async queryRows(
    input: {
      appId?: ProviderSessionArtifact['appId'];
      agentId?: ProviderSessionArtifact['agentId'];
      agentSessionId?: ProviderSessionArtifact['agentSessionId'];
      providerSessionId?: ProviderSessionArtifact['providerSessionId'];
      provider?: string;
      artifactKind?: ProviderSessionArtifactKind;
      includeDeleted?: boolean;
    },
    limit: number,
  ): Promise<ArtifactRow[]> {
    const table = pgSchema.providerSessionArtifactsPostgres;
    const predicates: SQL[] = [];
    if (input.appId) predicates.push(eq(table.appId, input.appId));
    if (input.agentId) predicates.push(eq(table.agentId, input.agentId));
    if (input.agentSessionId) {
      predicates.push(eq(table.agentSessionId, input.agentSessionId));
    }
    if (input.providerSessionId) {
      predicates.push(eq(table.providerSessionId, input.providerSessionId));
    }
    if (input.provider) predicates.push(eq(table.provider, input.provider));
    if (input.artifactKind) {
      predicates.push(eq(table.artifactKind, input.artifactKind));
    }
    if (!input.includeDeleted) predicates.push(isNull(table.deletedAt));

    const query = this.db
      .select()
      .from(table)
      .where(predicates.length > 0 ? and(...predicates) : undefined)
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(limit);
    return query;
  }

  private fromRow(row: ArtifactRow): ProviderSessionArtifact {
    return {
      id: row.id,
      appId: row.appId,
      agentId: row.agentId,
      agentSessionId: row.agentSessionId,
      providerSessionId: row.providerSessionId,
      provider: row.provider,
      artifactKind: row.artifactKind as ProviderSessionArtifactKind,
      storageType: row.storageType as ProviderSessionArtifactStorageType,
      storageRef: row.storageRef,
      contentHash: row.contentHash,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      metadata: parseJson(row.metadataJson, {}),
      deletedAt: row.deletedAt ?? undefined,
    } as ProviderSessionArtifact;
  }

  private verifyContent(
    artifact: ProviderSessionArtifact,
    content: Buffer,
  ): void {
    const actualHash = sha256(content);
    if (actualHash !== artifact.contentHash) {
      throw new Error(
        `Provider artifact hash mismatch for ${artifact.id}: expected ${artifact.contentHash}, got ${actualHash}`,
      );
    }
    if (content.byteLength !== artifact.sizeBytes) {
      throw new Error(
        `Provider artifact size mismatch for ${artifact.id}: expected ${artifact.sizeBytes}, got ${content.byteLength}`,
      );
    }
  }
}
