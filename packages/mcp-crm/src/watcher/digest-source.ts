import type { Pool } from 'pg';

export interface PendingDigest {
  digestId: string;
  conversationId: string;
  digestText: string;
  digestAt: string;
}

export interface PendingDigestFilter {
  conversationId?: string;
  since?: string;
  limit?: number;
}

// Session-end digests for Boondi conversations not yet processed by THIS watcher.
// The digest row's existence = "session ended + digest ready" (Gantry writes it
// before facts/cursor). agentId scopes to Boondi; we only key off the conversation.
export function pendingDigestsSql(
  gantrySchema: string,
  filter: PendingDigestFilter = {},
): string {
  const predicates = [
    "d.trigger = 'session-end'",
    's.agent_id = $1',
    "s.conversation_id LIKE 'conversation:wa:%'",
    '(c.last_digest_at IS NULL OR d.created_at > c.last_digest_at)',
  ];
  let nextParam = 2;
  if (filter.conversationId)
    predicates.push(`s.conversation_id = $${nextParam++}`);
  if (filter.since)
    predicates.push(`d.created_at >= $${nextParam++}::timestamptz`);
  return `SELECT d.id AS digest_id, s.conversation_id, d.digest, d.created_at
            FROM ${gantrySchema}.agent_session_digests d
            JOIN ${gantrySchema}.agent_sessions s ON s.id = d.agent_session_id
            LEFT JOIN boondi_digest_cursor c ON c.conversation_id = s.conversation_id
           WHERE ${predicates.join('\n             AND ')}
           ORDER BY d.created_at ASC
           LIMIT $${nextParam}`;
}

export async function findNewDigests(
  pool: Pool,
  gantrySchema: string,
  agentId: string,
  filter: PendingDigestFilter = {},
): Promise<PendingDigest[]> {
  const params: unknown[] = [agentId];
  if (filter.conversationId) params.push(filter.conversationId);
  if (filter.since) params.push(filter.since);
  params.push(filter.limit ?? 25);
  const res = await pool.query(pendingDigestsSql(gantrySchema, filter), params);
  return res.rows.map((r) => ({
    digestId: r.digest_id as string,
    conversationId: r.conversation_id as string,
    digestText: (r.digest as string | null) ?? '',
    digestAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  }));
}

export async function advanceDigestCursor(
  pool: Pool,
  conversationId: string,
  digestId: string,
  digestAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO boondi_digest_cursor (conversation_id, last_digest_id, last_digest_at, checked_at)
       VALUES ($1,$2,$3, now())
     ON CONFLICT (conversation_id) DO UPDATE
       SET last_digest_id = EXCLUDED.last_digest_id,
           last_digest_at = EXCLUDED.last_digest_at, checked_at = now()`,
    [conversationId, digestId, digestAt],
  );
}
