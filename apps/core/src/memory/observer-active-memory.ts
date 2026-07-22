import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { ObserverSubjectKey } from '../domain/ports/observer-insights.js';
import { canonicalizeObserverInsightText } from '../shared/observer-insight-policy.js';

const Items = pgSchema.memoryItemsPostgres;

export async function loadCanonicalActiveMemoryValues(input: {
  db: NodePgDatabase<typeof pgSchema>;
  appId: string;
  subject: ObserverSubjectKey;
}): Promise<ReadonlySet<string>> {
  const filters: SQL[] = [
    eq(Items.appId, input.appId),
    eq(Items.status, 'active'),
  ];
  if (input.subject.startsWith('conversation:')) {
    filters.push(eq(Items.conversationId, input.subject));
  } else if (input.subject === 'observer:app') {
    filters.push(eq(Items.subjectType, 'common'));
  } else {
    filters.push(eq(Items.subjectId, input.subject));
  }

  const rows = await input.db
    .select({ value: sql<string | null>`${Items.valueJson}->>'value'` })
    .from(Items)
    .where(and(...filters));

  const values = new Set<string>();
  for (const row of rows) {
    if (typeof row.value !== 'string') continue;
    const value = canonicalizeObserverInsightText(row.value);
    if (value) values.add(value);
  }
  return values;
}

export async function hasExactActiveMemoryMatch(input: {
  db: NodePgDatabase<typeof pgSchema>;
  appId: string;
  subject: ObserverSubjectKey;
  candidateText: string;
}): Promise<boolean> {
  const candidate = canonicalizeObserverInsightText(input.candidateText);
  if (!candidate) return false;
  const values = await loadCanonicalActiveMemoryValues(input);
  return values.has(candidate);
}
