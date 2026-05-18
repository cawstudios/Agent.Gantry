import { eq } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export async function updateCanonicalJobRunProviderMetadata(
  db: CanonicalDb,
  runId: string,
  input: {
    providerRunId?: string | null;
    providerSessionId?: string | null;
  },
): Promise<void> {
  const updates: Partial<typeof pgSchema.agentRunsPostgres.$inferInsert> = {};
  if (input.providerRunId !== undefined)
    updates.providerRunId = input.providerRunId;
  if (input.providerSessionId !== undefined) {
    updates.providerSessionId = input.providerSessionId;
  }
  if (Object.keys(updates).length === 0) return;
  await db
    .update(pgSchema.agentRunsPostgres)
    .set(updates)
    .where(eq(pgSchema.agentRunsPostgres.id, runId));
}
