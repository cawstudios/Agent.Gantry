import type { AppMemoryItem } from './memory-types.js';
import type { EmbeddingProvider } from './memory-embeddings.js';
import { runWithMemoryOperationTimeout } from '../shared/memory-dreaming-timeout.js';

export const DREAM_EMBEDDING_DEADLINE_MS = 15_000;

export async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: { signal?: AbortSignal; label?: string } = {},
): Promise<T> {
  return runWithMemoryOperationTimeout(operation, {
    timeoutMs,
    label: options.label ?? 'dream embedding',
    parentSignal: options.signal,
  });
}

export async function storeDreamItemEmbedding(input: {
  db: any;
  schema: any;
  sqlOps: any;
  now: () => string;
  provider: EmbeddingProvider;
  providerName: string;
  model: string;
  item: AppMemoryItem;
  contentHash: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ status: 'stored' | 'retryable'; reason?: string }> {
  const now = input.now();
  const { schema, sqlOps } = input;
  const [existing] = await input.db
    .select()
    .from(schema.memoryItemEmbeddingsPostgres)
    .where(
      sqlOps.and(
        sqlOps.eq(schema.memoryItemEmbeddingsPostgres.itemId, input.item.id),
        sqlOps.eq(
          schema.memoryItemEmbeddingsPostgres.provider,
          input.providerName,
        ),
        sqlOps.eq(schema.memoryItemEmbeddingsPostgres.model, input.model),
        sqlOps.eq(
          schema.memoryItemEmbeddingsPostgres.contentHash,
          input.contentHash,
        ),
      ),
    )
    .limit(1);
  if (existing?.status === 'ready' && existing.embeddingJson !== null) {
    return { status: 'stored' };
  }

  const embeddingText = [input.item.key, input.item.value, input.item.why]
    .filter((value): value is string => typeof value === 'string' && !!value)
    .join('\n');
  const timeoutMs = Math.max(1, input.timeoutMs ?? DREAM_EMBEDDING_DEADLINE_MS);
  try {
    const embedding = await runWithTimeout(
      (signal) => input.provider.embedOne(embeddingText, { signal }),
      timeoutMs,
      { signal: input.signal },
    );
    await input.db
      .insert(schema.memoryItemEmbeddingsPostgres)
      .values({
        itemId: input.item.id,
        provider: input.providerName,
        model: input.model,
        contentHash: input.contentHash,
        embeddingJson: JSON.stringify(embedding),
        status: 'ready',
        error: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.memoryItemEmbeddingsPostgres.itemId,
          schema.memoryItemEmbeddingsPostgres.provider,
          schema.memoryItemEmbeddingsPostgres.model,
          schema.memoryItemEmbeddingsPostgres.contentHash,
        ],
        set: {
          embeddingJson: JSON.stringify(embedding),
          status: 'ready',
          error: null,
          updatedAt: now,
        },
      });
    return { status: 'stored' };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'unknown embedding error';
    await input.db
      .insert(schema.memoryItemEmbeddingsPostgres)
      .values({
        itemId: input.item.id,
        provider: input.providerName,
        model: input.model,
        contentHash: input.contentHash,
        embeddingJson: null,
        status: 'retryable_error',
        error: reason.slice(0, 500),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.memoryItemEmbeddingsPostgres.itemId,
          schema.memoryItemEmbeddingsPostgres.provider,
          schema.memoryItemEmbeddingsPostgres.model,
          schema.memoryItemEmbeddingsPostgres.contentHash,
        ],
        set: {
          embeddingJson: null,
          status: 'retryable_error',
          error: reason.slice(0, 500),
          updatedAt: now,
        },
      });
    return {
      status: 'retryable',
      reason,
    };
  }
}
