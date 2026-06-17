import { and, eq, isNotNull, lt } from 'drizzle-orm';

import type {
  LatencyTimeline,
  LatencyTimings,
} from '../../../../runtime/reply-trace.js';
import { messageTracesPostgres } from '../schema/message-traces.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export type MessageTraceKind = 'reply' | 'command';

const DEFAULT_TRACE_PAYLOAD_MAX_BYTES = 512 * 1024;
const REDACTED = '[REDACTED]';

export interface MessageTraceRow {
  /** Canonical message id (message:${chatJid}:${id}) — FK to messages.id. */
  messageId: string;
  appId: string;
  conversationId: string;
  kind: MessageTraceKind;
  totalMs: number;
  timingsJson: LatencyTimings | LatencyTimeline;
  payloadsJson: Record<number | string, unknown> | null;
  /** ISO timestamp string (timestamptz mode: 'string'). */
  createdAt: string;
}

export interface MessageTracePayloadRead {
  messageId: string;
  appId: string;
  conversationId: string;
  payloadsJson: Record<number | string, unknown> | null;
  createdAt: string;
}

export interface ReadMessageTracePayloadsInput {
  appId: string;
  messageId: string;
}

export interface ClearMessageTracePayloadsOlderThanInput {
  appId: string;
  before: string;
}

interface TraceRepoLogger {
  warn: (payload: Record<string, unknown>, message: string) => void;
}

interface MessageTraceRepositoryOptions {
  payloadMaxBytes?: number;
}

function normalizeTimestamp(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'setcookie' ||
    normalized.includes('apikey') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('credential') ||
    normalized.includes('bearer') ||
    normalized === 'token' ||
    normalized.endsWith('token') ||
    normalized === 'privatekey' ||
    normalized === 'accesskey'
  );
}

function redactPayload(value: unknown, key?: string): unknown {
  if (key && isSecretKey(key)) return REDACTED;
  if (typeof value === 'string') {
    if (/^Bearer\s+\S+/i.test(value)) return REDACTED;
    if (/^(sk|pk|xox[baprs]?)-[A-Za-z0-9_-]{12,}/.test(value)) {
      return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([childKey, item]) => [childKey, redactPayload(item, childKey)],
      ),
    );
  }
  return value;
}

function applyPayloadPolicy(
  payloadsJson: MessageTraceRow['payloadsJson'],
  maxBytes: number,
): MessageTraceRow['payloadsJson'] {
  if (payloadsJson === null) return null;
  const redacted = redactPayload(payloadsJson) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= maxBytes) return redacted;
  return {
    __gantryPayloadPolicy: {
      truncated: true,
      reason: 'payload_byte_limit_exceeded',
      originalBytes: bytes,
      maxBytes,
    },
  };
}

/**
 * Best-effort persistence for the per-reply latency trace.
 *
 * INVARIANT: a trace failure (db down, FK race, constraint) must NEVER throw
 * into the reply path. `save` swallows every error and logs at warn. The trace
 * is diagnostics-only; the customer reply has already been sent by the time
 * this runs.
 */
export class PostgresMessageTraceRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly logger?: TraceRepoLogger,
    private readonly options: MessageTraceRepositoryOptions = {},
  ) {}

  async save(row: MessageTraceRow): Promise<void> {
    try {
      const values = {
        ...row,
        payloadsJson: applyPayloadPolicy(
          row.payloadsJson,
          this.options.payloadMaxBytes ?? DEFAULT_TRACE_PAYLOAD_MAX_BYTES,
        ),
      };
      await this.db
        .insert(messageTracesPostgres)
        .values(values)
        .onConflictDoNothing();
    } catch (err) {
      this.logger?.warn(
        {
          err,
          messageId: row.messageId,
          conversationId: row.conversationId,
          kind: row.kind,
        },
        'Failed to persist message trace (best-effort, ignored)',
      );
    }
  }

  async readPayloads(
    input: ReadMessageTracePayloadsInput,
  ): Promise<MessageTracePayloadRead | null> {
    const rows = await this.db
      .select({
        messageId: messageTracesPostgres.messageId,
        appId: messageTracesPostgres.appId,
        conversationId: messageTracesPostgres.conversationId,
        payloadsJson: messageTracesPostgres.payloadsJson,
        createdAt: messageTracesPostgres.createdAt,
      })
      .from(messageTracesPostgres)
      .where(
        and(
          eq(messageTracesPostgres.appId, input.appId),
          eq(messageTracesPostgres.messageId, input.messageId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      messageId: row.messageId,
      appId: row.appId,
      conversationId: row.conversationId,
      payloadsJson: row.payloadsJson as Record<number | string, unknown> | null,
      createdAt: normalizeTimestamp(row.createdAt),
    };
  }

  async clearPayloadsOlderThan(
    input: ClearMessageTracePayloadsOlderThanInput,
  ): Promise<number> {
    const updated = await this.db
      .update(messageTracesPostgres)
      .set({ payloadsJson: null })
      .where(
        and(
          eq(messageTracesPostgres.appId, input.appId),
          lt(messageTracesPostgres.createdAt, input.before),
          isNotNull(messageTracesPostgres.payloadsJson),
        ),
      )
      .returning({ messageId: messageTracesPostgres.messageId });
    return updated.length;
  }
}
