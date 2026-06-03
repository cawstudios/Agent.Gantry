import { eq } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
import type {
  MemoryExtractionCursor,
  MemoryExtractionCursorRepository,
} from '../../../../domain/ports/repositories.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

function cursorId(i: {
  appId: string;
  agentId: string;
  conversationId: string;
  threadId?: string | null;
}): string {
  return `${i.appId}|${i.agentId}|${i.conversationId}|${i.threadId ?? ''}`;
}

export class PostgresMemoryExtractionCursorRepository
  implements MemoryExtractionCursorRepository
{
  constructor(private readonly db: CanonicalDb) {}

  async getCursor(
    input: Parameters<MemoryExtractionCursorRepository['getCursor']>[0],
  ): Promise<MemoryExtractionCursor | null> {
    const rows = await this.db
      .select({
        coveredThroughAt:
          pgSchema.memoryExtractionCursorPostgres.coveredThroughAt,
        coveredThroughMessageId:
          pgSchema.memoryExtractionCursorPostgres.coveredThroughMessageId,
      })
      .from(pgSchema.memoryExtractionCursorPostgres)
      .where(
        eq(pgSchema.memoryExtractionCursorPostgres.id, cursorId(input)),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          coveredThroughAt: row.coveredThroughAt,
          coveredThroughMessageId: row.coveredThroughMessageId,
        }
      : null;
  }

  async upsertCursor(
    input: Parameters<MemoryExtractionCursorRepository['upsertCursor']>[0],
  ): Promise<void> {
    const id = cursorId(input);
    const now = nowIso();
    await this.db
      .insert(pgSchema.memoryExtractionCursorPostgres)
      .values({
        id,
        appId: input.appId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        threadId: input.threadId ?? null,
        coveredThroughAt: input.coveredThroughAt,
        coveredThroughMessageId: input.coveredThroughMessageId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pgSchema.memoryExtractionCursorPostgres.id,
        set: {
          coveredThroughAt: input.coveredThroughAt,
          coveredThroughMessageId: input.coveredThroughMessageId,
          updatedAt: now,
        },
      });
  }
}
