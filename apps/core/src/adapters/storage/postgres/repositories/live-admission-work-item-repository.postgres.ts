import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type {
  LiveAdmissionWorkItem,
  LiveAdmissionWorkItemEnqueueResult,
  SdkSessionAdmissionPreflight,
  SdkSessionAdmissionPreflightResult,
  SdkSessionQueuePolicy,
  SdkSessionTurnState,
} from '../../../../domain/ports/live-turns.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';

type LiveAdmissionWorkItemRow =
  typeof pgSchema.liveAdmissionWorkItemsPostgres.$inferSelect;

function toLiveAdmissionWorkItem(
  row: LiveAdmissionWorkItemRow,
): LiveAdmissionWorkItem {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    agentSessionId: row.agentSessionId,
    conversationId: row.conversationId,
    threadId: row.threadId,
    queueJid: row.queueJid,
    messageId: row.messageId,
    messageCursor: row.messageCursor,
    senderUserId: row.senderUserId,
    senderDisplayName: row.senderDisplayName,
    idempotencyKey: row.idempotencyKey,
    requestMessageId: row.requestMessageId,
    requestFingerprint: row.requestFingerprint,
    acceptedEventId: row.acceptedEventId,
    turnState: row.turnState as SdkSessionTurnState | null,
    queueDeadlineAt: row.queueDeadlineAt,
    executionTimeoutMs: row.executionTimeoutMs,
    executionDeadlineAt: row.executionDeadlineAt,
    turnStartedAt: row.turnStartedAt,
    turnEndedAt: row.turnEndedAt,
    terminalCode: row.terminalCode,
    state: row.state as LiveAdmissionWorkItem['state'],
    sourceKind: 'message',
    triggerDecision: (row.triggerDecisionJson ?? {}) as Record<string, unknown>,
    claimWorkerInstanceId: row.claimWorkerInstanceId,
    claimToken: row.claimToken,
    claimExpiresAt: row.claimExpiresAt,
    fencingVersion: row.fencingVersion,
    retryCount: row.retryCount,
    failureCount: row.failureCount,
    deferUntil: row.deferUntil,
    deferredReason: row.deferredReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    claimedAt: row.claimedAt,
    endedAt: row.endedAt,
  };
}

export async function enqueueLiveAdmissionWorkItem(
  db: CanonicalExecutor,
  input: {
    id: string;
    appId: string;
    agentId?: string | null;
    agentSessionId?: string | null;
    conversationId: string;
    threadId?: string | null;
    queueJid: string;
    messageId: string;
    messageCursor: string;
    senderUserId?: string | null;
    senderDisplayName?: string | null;
    idempotencyKey: string;
    requestMessageId?: string | null;
    requestFingerprint?: string | null;
    acceptedEventId?: number | null;
    turnState?: SdkSessionTurnState | null;
    queueDeadlineAt?: string | null;
    executionTimeoutMs?: number | null;
    executionDeadlineAt?: string | null;
    turnStartedAt?: string | null;
    turnEndedAt?: string | null;
    terminalCode?: string | null;
    triggerDecision?: Record<string, unknown>;
    now?: string;
  },
): Promise<LiveAdmissionWorkItemEnqueueResult> {
  const now = input.now ?? currentIso();
  const row: LiveAdmissionWorkItemRow = {
    id: input.id,
    appId: input.appId,
    agentId: input.agentId ?? null,
    agentSessionId: input.agentSessionId ?? null,
    conversationId: input.conversationId,
    threadId: input.threadId ?? null,
    queueJid: input.queueJid,
    messageId: input.messageId,
    messageCursor: input.messageCursor,
    senderUserId: input.senderUserId ?? null,
    senderDisplayName: input.senderDisplayName ?? null,
    idempotencyKey: input.idempotencyKey,
    requestMessageId: input.requestMessageId ?? null,
    requestFingerprint: input.requestFingerprint ?? null,
    acceptedEventId: input.acceptedEventId ?? null,
    turnState: input.turnState ?? null,
    queueDeadlineAt: input.queueDeadlineAt ?? null,
    executionTimeoutMs: input.executionTimeoutMs ?? null,
    executionDeadlineAt: input.executionDeadlineAt ?? null,
    turnStartedAt: input.turnStartedAt ?? null,
    turnEndedAt: input.turnEndedAt ?? null,
    terminalCode: input.terminalCode ?? null,
    state: 'queued',
    sourceKind: 'message',
    triggerDecisionJson: input.triggerDecision ?? {},
    claimWorkerInstanceId: null,
    claimToken: null,
    claimExpiresAt: null,
    fencingVersion: 0,
    retryCount: 0,
    failureCount: 0,
    deferUntil: null,
    deferredReason: null,
    createdAt: now,
    updatedAt: now,
    claimedAt: null,
    endedAt: null,
  };
  const inserted = await db
    .insert(pgSchema.liveAdmissionWorkItemsPostgres)
    .values(row)
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    return { outcome: 'enqueued', item: toLiveAdmissionWorkItem(row) };
  }
  const existing = await findLiveAdmissionWorkItemByIdempotencyKey(
    db,
    input.idempotencyKey,
  );
  const replayed =
    existing ?? (await findLiveAdmissionWorkItemById(db, input.id));
  if (!replayed) {
    throw new Error('Live admission work item conflict was not replayable.');
  }
  return { outcome: 'replayed', item: replayed };
}

export function makeSdkSessionAdmissionIdempotencyKey(input: {
  appId: string;
  agentSessionId: string;
  idempotencyKey: string;
}): string {
  const key = input.idempotencyKey.trim();
  if (!key || key.length > 200) {
    throw new Error(
      'SDK session idempotencyKey must contain 1 to 200 characters.',
    );
  }
  return [
    'sdk-session',
    encodeURIComponent(input.appId.trim()),
    encodeURIComponent(input.agentSessionId.trim()),
    encodeURIComponent(key),
  ].join(':');
}

/**
 * Checks replay and capacity while holding the session-scoped transaction
 * lock. This deliberately does not insert a work item: the canonical message
 * id does not exist yet. The caller must save the canonical message and call
 * promoteSdkSessionAdmissionWithExecutor with the returned token in this same
 * transaction.
 */
export async function preflightSdkSessionAdmissionWithExecutor(
  db: CanonicalExecutor,
  input: {
    appId: string;
    agentSessionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    queuePolicy?: SdkSessionQueuePolicy;
    now?: string;
  },
): Promise<SdkSessionAdmissionPreflightResult> {
  const now = input.now ?? currentIso();
  const requestFingerprint = input.requestFingerprint.trim();
  if (!requestFingerprint) {
    throw new Error('SDK session request fingerprint is required.');
  }
  if (input.queuePolicy) validateSdkSessionQueuePolicy(input.queuePolicy);
  const idempotencyKey = makeSdkSessionAdmissionIdempotencyKey(input);
  const lockKey = `sdk-session-admission:${input.appId}:${input.agentSessionId}`;
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );

  const replay = await findLiveAdmissionWorkItemByIdempotencyKey(
    db,
    idempotencyKey,
  );
  if (replay) {
    return replay.requestFingerprint === requestFingerprint
      ? { outcome: 'replayed', item: replay }
      : { outcome: 'fingerprint_conflict', item: replay };
  }

  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  if (input.queuePolicy) {
    const countRows = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(items)
      .where(
        and(
          eq(items.appId, input.appId),
          eq(items.agentSessionId, input.agentSessionId),
          isNotNull(items.requestFingerprint),
          inArray(items.turnState, ['waiting', 'running']),
        ),
      );
    const activeAndWaiting = Number(countRows[0]?.value ?? 0);
    const capacity = input.queuePolicy.maxWaitingMessages + 1;
    if (activeAndWaiting >= capacity) {
      return { outcome: 'capacity_exceeded', activeAndWaiting, capacity };
    }
  }

  const queueDeadlineAt = input.queuePolicy
    ? new Date(Date.parse(now) + input.queuePolicy.maxQueueWaitMs).toISOString()
    : null;
  return {
    outcome: 'available',
    preflight: {
      appId: input.appId,
      agentSessionId: input.agentSessionId,
      idempotencyKey,
      requestFingerprint,
      turnState: input.queuePolicy ? 'waiting' : null,
      queueDeadlineAt,
      executionTimeoutMs: input.queuePolicy?.executionTimeoutMs ?? null,
      now,
    },
  };
}

/**
 * Promotes a successful preflight after canonical message persistence. Both
 * calls must share one transaction so the advisory lock still protects the
 * capacity decision from concurrent SDK submissions.
 */
export async function promoteSdkSessionAdmissionWithExecutor(
  db: CanonicalExecutor,
  input: {
    id: string;
    appId: string;
    agentId?: string | null;
    agentSessionId: string;
    conversationId: string;
    threadId?: string | null;
    queueJid: string;
    messageId: string;
    requestMessageId: string;
    messageCursor: string;
    senderUserId?: string | null;
    senderDisplayName?: string | null;
    preflight: SdkSessionAdmissionPreflight;
    triggerDecision?: Record<string, unknown>;
    now?: string;
  },
): Promise<LiveAdmissionWorkItemEnqueueResult> {
  if (
    input.preflight.appId !== input.appId ||
    input.preflight.agentSessionId !== input.agentSessionId
  ) {
    throw new Error('SDK session admission preflight scope mismatch.');
  }
  const promoted = await enqueueLiveAdmissionWorkItem(db, {
    id: input.id,
    appId: input.appId,
    agentId: input.agentId,
    agentSessionId: input.agentSessionId,
    conversationId: input.conversationId,
    threadId: input.threadId,
    queueJid: input.queueJid,
    messageId: input.messageId,
    requestMessageId: input.requestMessageId,
    messageCursor: input.messageCursor,
    senderUserId: input.senderUserId,
    senderDisplayName: input.senderDisplayName,
    idempotencyKey: input.preflight.idempotencyKey,
    requestFingerprint: input.preflight.requestFingerprint,
    acceptedEventId: null,
    turnState: input.preflight.turnState,
    queueDeadlineAt: input.preflight.queueDeadlineAt,
    executionTimeoutMs: input.preflight.executionTimeoutMs,
    executionDeadlineAt: null,
    turnStartedAt: null,
    turnEndedAt: null,
    terminalCode: null,
    triggerDecision: input.triggerDecision,
    now: input.now ?? input.preflight.now,
  });
  if (
    promoted.outcome === 'replayed' &&
    promoted.item.requestFingerprint !== input.preflight.requestFingerprint
  ) {
    throw new Error(
      'SDK session admission fingerprint changed after preflight.',
    );
  }
  return promoted;
}

export async function linkSdkSessionAcceptedEventWithExecutor(
  db: CanonicalExecutor,
  input: { id: string; acceptedEventId: number; now?: string },
): Promise<LiveAdmissionWorkItem | null> {
  if (!Number.isInteger(input.acceptedEventId) || input.acceptedEventId < 1) {
    throw new Error('acceptedEventId must be a positive integer.');
  }
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .update(items)
    .set({
      acceptedEventId: input.acceptedEventId,
      updatedAt: input.now ?? currentIso(),
    })
    .where(and(eq(items.id, input.id), isNotNull(items.requestFingerprint)))
    .returning();
  return rows[0] ? toLiveAdmissionWorkItem(rows[0]) : null;
}

export async function findSdkSessionTurnWithExecutor(
  db: CanonicalExecutor,
  input: { messageId: string },
): Promise<LiveAdmissionWorkItem | null> {
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .select()
    .from(items)
    .where(
      and(
        eq(items.messageId, input.messageId),
        isNotNull(items.requestFingerprint),
      ),
    )
    .limit(1);
  return rows[0] ? toLiveAdmissionWorkItem(rows[0]) : null;
}

export async function markSdkSessionTurnRunningWithExecutor(
  db: CanonicalExecutor,
  input: {
    messageId: string;
    executionDeadlineAt: string;
    now?: string;
  },
): Promise<LiveAdmissionWorkItem | null> {
  const now = input.now ?? currentIso();
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .update(items)
    .set({
      turnState: 'running',
      executionDeadlineAt: input.executionDeadlineAt,
      turnStartedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(items.messageId, input.messageId),
        isNotNull(items.requestFingerprint),
        eq(items.turnState, 'waiting'),
      ),
    )
    .returning();
  return rows[0] ? toLiveAdmissionWorkItem(rows[0]) : null;
}

export async function settleSdkSessionTurnWithExecutor(
  db: CanonicalExecutor,
  input: {
    messageId: string;
    state: Extract<
      SdkSessionTurnState,
      'completed' | 'failed' | 'timed_out' | 'canceled'
    >;
    fromStates?: Array<Extract<SdkSessionTurnState, 'waiting' | 'running'>>;
    terminalCode?: string | null;
    now?: string;
  },
): Promise<LiveAdmissionWorkItem | null> {
  const now = input.now ?? currentIso();
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .update(items)
    .set({
      turnState: input.state,
      terminalCode: input.terminalCode ?? null,
      turnEndedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(items.messageId, input.messageId),
        isNotNull(items.requestFingerprint),
        inArray(items.turnState, input.fromStates ?? ['waiting', 'running']),
      ),
    )
    .returning();
  return rows[0] ? toLiveAdmissionWorkItem(rows[0]) : null;
}

function validateSdkSessionQueuePolicy(policy: SdkSessionQueuePolicy): void {
  if (
    !Number.isInteger(policy.maxWaitingMessages) ||
    policy.maxWaitingMessages < 0
  ) {
    throw new Error('maxWaitingMessages must be a non-negative integer.');
  }
  for (const [name, value] of [
    ['maxQueueWaitMs', policy.maxQueueWaitMs],
    ['executionTimeoutMs', policy.executionTimeoutMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
}

export async function claimLiveAdmissionWorkItems(
  db: CanonicalDb,
  input: {
    appId: string;
    workerInstanceId: string;
    claimToken: string;
    claimExpiresAt: string;
    limit: number;
    now?: string;
  },
): Promise<LiveAdmissionWorkItem[]> {
  const now = input.now ?? currentIso();
  const limit = Math.max(1, Math.floor(input.limit));
  const candidateLimit = limit * 4;
  return db.transaction(async (tx) => {
    const items = pgSchema.liveAdmissionWorkItemsPostgres;
    const sdkSessionHeadEligible = sql`(
      ${items.requestFingerprint} IS NULL
      OR ${items.agentSessionId} IS NULL
      OR ${items.turnState} <> 'waiting'
      OR NOT EXISTS (
        SELECT 1
        FROM ${items} AS sdk_prior
        WHERE sdk_prior."app_id" = ${items.appId}
          AND sdk_prior."agent_session_id" = ${items.agentSessionId}
          AND sdk_prior."request_fingerprint" IS NOT NULL
          AND sdk_prior."turn_state" IN ('waiting', 'running')
          AND (sdk_prior."created_at", sdk_prior."id") <
              (${items.createdAt}, ${items.id})
      )
    )`;
    const candidates = await tx.execute<{ id: string }>(sql`
      WITH queued AS (
        SELECT ${items.id} AS id, ${items.createdAt} AS created_at
        FROM ${items}
        WHERE ${items.appId} = ${input.appId}
          AND ${items.state} = 'queued'
          AND ${sdkSessionHeadEligible}
        ORDER BY ${items.createdAt} ASC, ${items.id} ASC
        LIMIT ${candidateLimit}
        FOR UPDATE SKIP LOCKED
      ),
      due_deferred AS (
        SELECT ${items.id} AS id, ${items.createdAt} AS created_at
        FROM ${items}
        WHERE ${items.appId} = ${input.appId}
          AND ${items.state} = 'deferred'
          AND ${items.deferUntil} <= ${now}
          AND ${sdkSessionHeadEligible}
        ORDER BY ${items.deferUntil} ASC, ${items.createdAt} ASC, ${items.id} ASC
        LIMIT ${candidateLimit}
        FOR UPDATE SKIP LOCKED
      ),
      null_deferred AS (
        SELECT ${items.id} AS id, ${items.createdAt} AS created_at
        FROM ${items}
        WHERE ${items.appId} = ${input.appId}
          AND ${items.state} = 'deferred'
          AND ${items.deferUntil} IS NULL
          AND ${sdkSessionHeadEligible}
        ORDER BY ${items.createdAt} ASC, ${items.id} ASC
        LIMIT ${candidateLimit}
        FOR UPDATE SKIP LOCKED
      ),
      expired_claimed AS (
        SELECT ${items.id} AS id, ${items.createdAt} AS created_at
        FROM ${items}
        WHERE ${items.appId} = ${input.appId}
          AND ${items.state} = 'claimed'
          AND ${items.claimExpiresAt} IS NOT NULL
          AND ${items.claimExpiresAt} <= ${now}
          AND ${sdkSessionHeadEligible}
        ORDER BY ${items.claimExpiresAt} ASC, ${items.createdAt} ASC, ${items.id} ASC
        LIMIT ${candidateLimit}
        FOR UPDATE SKIP LOCKED
      ),
      candidates AS (
        SELECT id, created_at FROM queued
        UNION ALL
        SELECT id, created_at FROM due_deferred
        UNION ALL
        SELECT id, created_at FROM null_deferred
        UNION ALL
        SELECT id, created_at FROM expired_claimed
      )
      SELECT id
      FROM candidates
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
    `);
    const ids = candidates.rows.map((candidate) => candidate.id);
    if (ids.length === 0) return [];
    const rows = await tx
      .update(items)
      .set({
        state: 'claimed',
        claimWorkerInstanceId: input.workerInstanceId,
        claimToken: input.claimToken,
        claimExpiresAt: input.claimExpiresAt,
        fencingVersion: sql`${items.fencingVersion} + 1`,
        retryCount: sql`${items.retryCount} + 1`,
        deferUntil: null,
        deferredReason: null,
        claimedAt: now,
        updatedAt: now,
      })
      .where(inArray(items.id, ids))
      .returning();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is LiveAdmissionWorkItemRow => Boolean(row))
      .map(toLiveAdmissionWorkItem);
  });
}

export async function renewLiveAdmissionWorkItemClaim(
  db: CanonicalDb,
  input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    claimExpiresAt: string;
    now?: string;
  },
): Promise<boolean> {
  const now = input.now ?? currentIso();
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .update(items)
    .set({
      claimExpiresAt: input.claimExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(items.id, input.id),
        eq(items.state, 'claimed'),
        eq(items.claimToken, input.claimToken),
        eq(items.claimWorkerInstanceId, input.workerInstanceId),
      ),
    )
    .returning({ id: items.id });
  return rows.length > 0;
}

export async function deferLiveAdmissionWorkItem(
  db: CanonicalDb,
  input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    reason: 'queued_capacity' | 'listener_degraded' | 'retry';
    deferUntil: string;
    countFailure?: boolean;
    now?: string;
  },
): Promise<boolean> {
  const now = input.now ?? currentIso();
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .update(items)
    .set({
      state: 'deferred',
      claimWorkerInstanceId: null,
      claimToken: null,
      claimExpiresAt: null,
      failureCount: input.countFailure
        ? sql`${items.failureCount} + 1`
        : sql`${items.failureCount}`,
      deferUntil: input.deferUntil,
      deferredReason: input.reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(items.id, input.id),
        eq(items.state, 'claimed'),
        eq(items.claimToken, input.claimToken),
        eq(items.claimWorkerInstanceId, input.workerInstanceId),
      ),
    )
    .returning({ id: items.id });
  return rows.length > 0;
}

export async function settleLiveAdmissionWorkItem(
  db: CanonicalDb,
  input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    state: Extract<
      LiveAdmissionWorkItem['state'],
      'completed' | 'failed' | 'canceled'
    >;
    now?: string;
  },
): Promise<boolean> {
  return Boolean(await settleLiveAdmissionWorkItemWithExecutor(db, input));
}

export async function settleLiveAdmissionWorkItemWithExecutor(
  db: CanonicalExecutor,
  input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    state: Extract<
      LiveAdmissionWorkItem['state'],
      'completed' | 'failed' | 'canceled'
    >;
    now?: string;
  },
): Promise<LiveAdmissionWorkItem | null> {
  const now = input.now ?? currentIso();
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .update(items)
    .set({
      state: input.state,
      updatedAt: now,
      endedAt: now,
    })
    .where(
      and(
        eq(items.id, input.id),
        eq(items.state, 'claimed'),
        eq(items.claimToken, input.claimToken),
        eq(items.claimWorkerInstanceId, input.workerInstanceId),
      ),
    )
    .returning();
  return rows[0] ? toLiveAdmissionWorkItem(rows[0]) : null;
}

async function findLiveAdmissionWorkItemByIdempotencyKey(
  db: CanonicalExecutor,
  idempotencyKey: string,
): Promise<LiveAdmissionWorkItem | null> {
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db
    .select()
    .from(items)
    .where(eq(items.idempotencyKey, idempotencyKey))
    .limit(1);
  const row = rows[0];
  return row ? toLiveAdmissionWorkItem(row) : null;
}

async function findLiveAdmissionWorkItemById(
  db: CanonicalExecutor,
  id: string,
): Promise<LiveAdmissionWorkItem | null> {
  const items = pgSchema.liveAdmissionWorkItemsPostgres;
  const rows = await db.select().from(items).where(eq(items.id, id)).limit(1);
  const row = rows[0];
  return row ? toLiveAdmissionWorkItem(row) : null;
}
