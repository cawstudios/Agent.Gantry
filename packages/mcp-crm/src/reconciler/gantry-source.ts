// Read-only access to Gantry's DURABLE transcript for the backstop, plus the
// boondi-owned idempotency cursor. boondi-crm reads Gantry's messages exactly the
// way the read-only dashboard does — a one-way dependency; Gantry never depends on
// boondi-crm. All table names are unqualified (the pool sets search_path).

import type { Pool } from 'pg';
import type { TranscriptMessage } from './classify.js';

export interface ReconcileCandidate {
  conversationId: string;
  phone: string;
  lastMessageId: string;
  lastActivityAt: string;
}

// conversation id is "conversation:wa:<digits>"; the bare digits are the customer
// key used everywhere else (records.phone, memory_items.user_id).
export function phoneFromConversationId(conversationId: string): string | undefined {
  const match = conversationId.match(/wa:(\d+)/);
  return match ? match[1] : undefined;
}

// Conversations that have gone idle (no message for >idleMinutes) but were active
// within the lookback window — i.e. concluded chats the backstop should check. We
// only look at settled conversations so we never race the live fast path mid-chat.
export async function findReconcileCandidates(
  pool: Pool,
  opts: { idleMinutes: number; lookbackHours: number; limit?: number },
): Promise<ReconcileCandidate[]> {
  const res = await pool.query(
    `SELECT m.conversation_id,
            max(m.created_at) AS last_activity,
            (array_agg(m.id ORDER BY m.created_at DESC, m.id DESC))[1] AS last_message_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
      WHERE m.created_at > now() - make_interval(hours => $1)
      GROUP BY m.conversation_id
     HAVING max(m.created_at) < now() - make_interval(mins => $2)
      ORDER BY max(m.created_at) DESC
      LIMIT $3`,
    [opts.lookbackHours, opts.idleMinutes, opts.limit ?? 200],
  );
  const candidates: ReconcileCandidate[] = [];
  for (const row of res.rows) {
    const conversationId = row.conversation_id as string;
    const phone = phoneFromConversationId(conversationId);
    if (!phone) continue; // only WhatsApp/Interakt direct conversations
    candidates.push({
      conversationId,
      phone,
      lastMessageId: row.last_message_id as string,
      lastActivityAt:
        row.last_activity instanceof Date
          ? row.last_activity.toISOString()
          : String(row.last_activity),
    });
  }
  return candidates;
}

// The conversation's text transcript, oldest→newest, role-tagged by direction.
export async function loadTranscript(
  pool: Pool,
  conversationId: string,
  maxMessages = 80,
): Promise<TranscriptMessage[]> {
  const res = await pool.query(
    `SELECT m.direction, p.payload_json->>'text' AS text
       FROM messages m
       JOIN message_parts p ON p.message_id = m.id AND p.kind = 'text'
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC, p.ordinal ASC
      LIMIT $2`,
    [conversationId, maxMessages],
  );
  const out: TranscriptMessage[] = [];
  for (const row of res.rows) {
    const text = (row.text as string | null)?.trim();
    if (!text) continue;
    out.push({
      role: row.direction === 'inbound' ? 'customer' : 'assistant',
      text,
    });
  }
  return out;
}

export interface ReconcileCursor {
  lastMessageId: string | null;
  lastActivityAt: string | null;
}

export async function getCursor(
  pool: Pool,
  conversationId: string,
): Promise<ReconcileCursor | null> {
  const res = await pool.query(
    `SELECT last_message_id, last_activity_at
       FROM boondi_reconcile_cursor WHERE conversation_id = $1`,
    [conversationId],
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  return {
    lastMessageId: (row.last_message_id as string | null) ?? null,
    lastActivityAt:
      row.last_activity_at instanceof Date
        ? row.last_activity_at.toISOString()
        : ((row.last_activity_at as string | null) ?? null),
  };
}

export async function advanceCursor(
  pool: Pool,
  conversationId: string,
  lastMessageId: string,
  lastActivityAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO boondi_reconcile_cursor (conversation_id, last_message_id, last_activity_at, checked_at)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (conversation_id) DO UPDATE
       SET last_message_id = EXCLUDED.last_message_id,
           last_activity_at = EXCLUDED.last_activity_at,
           checked_at = now()`,
    [conversationId, lastMessageId, lastActivityAt],
  );
}
