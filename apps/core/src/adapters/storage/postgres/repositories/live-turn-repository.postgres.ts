import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import type {
  LiveAdmissionWorkItem,
  LiveAdmissionClaimInput,
  LiveAdmissionWorkItemEnqueueResult,
  LiveAdmissionWorkItemNotifier,
  LiveTurn,
  LiveTurnAgentRunCompletion,
  LiveTurnCommand,
  LiveTurnCommandNotifier,
  LiveTurnCoordinationRepository,
  LiveTurnLeaseFence,
  LiveTurnScope,
  LiveTurnState,
} from '../../../../domain/ports/live-turns.js';
import type { RuntimeEvent } from '../../../../domain/events/events.js';
import type { AppMessageResponseRoute } from '../../../../domain/types.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import {
  LIVE_TURN_TERMINAL_STATES,
  isTerminalLiveTurnState,
  makeLiveTurnScopeKey,
} from '../../../../domain/ports/live-turns.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import { redactProviderSessionHandlesInText } from '../../../../shared/provider-session-redaction.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { PostgresRuntimeEventRepository } from './runtime-event-repository.postgres.js';
import { activeRunLeaseFence } from './run-lease-fence.postgres.js';
import { redactTerminalToolPayloads } from './terminal-tool-payload-redaction.postgres.js';
import {
  claimLiveAdmissionWorkItems,
  deferLiveAdmissionWorkItem,
  enqueueLiveAdmissionWorkItem,
  findSdkSessionTurnWithExecutor,
  markSdkSessionTurnRunningWithExecutor,
  renewLiveAdmissionWorkItemClaim,
  settleSdkSessionTurnWithExecutor,
  settleLiveAdmissionWorkItem,
  settleLiveAdmissionWorkItemWithExecutor,
} from './live-admission-work-item-repository.postgres.js';
import { getOldestWaitingLiveAdmission as queryOldestWaitingLiveAdmission } from './live-waiting-admission-query.postgres.js';
import {
  appendLiveTurnCommand as appendLiveTurnCommandRow,
  toLiveTurnCommand,
  type AppendLiveTurnCommandInput,
} from './live-turn-command-row.postgres.js';
import {
  isUniqueViolation,
  settleRunLeaseTx,
} from './worker-coordination-lease.postgres.js';

type LiveTurnRow = typeof pgSchema.liveTurnsPostgres.$inferSelect;
type EnqueueLiveAdmissionWorkItemInput = Parameters<
  LiveTurnCoordinationRepository['enqueueLiveAdmissionWorkItem']
>[0];
type RenewLiveAdmissionWorkItemClaimInput = Parameters<
  LiveTurnCoordinationRepository['renewLiveAdmissionWorkItemClaim']
>[0];

type TerminalRuntimePublication = {
  event: RuntimeEvent;
  sdkTurn: LiveAdmissionWorkItem | null;
};

const TERMINAL_STATES = [...LIVE_TURN_TERMINAL_STATES];

function appResponseRouteFromPendingMessage(
  pendingMessage: Record<string, unknown> | null,
): AppMessageResponseRoute | undefined {
  const raw = pendingMessage?.appResponseRoute;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Live turn app response route is invalid');
  }
  const route = raw as Record<string, unknown>;
  if (
    typeof route.sessionId !== 'string' ||
    !route.sessionId.trim() ||
    (route.threadId !== null && typeof route.threadId !== 'string') ||
    !['sse', 'webhook', 'both', 'none'].includes(String(route.responseMode)) ||
    (route.webhookId !== null && typeof route.webhookId !== 'string') ||
    (route.correlationId !== null && typeof route.correlationId !== 'string')
  ) {
    throw new Error('Live turn app response route is invalid');
  }
  return route as unknown as AppMessageResponseRoute;
}

function toLiveTurn(row: LiveTurnRow): LiveTurn {
  return {
    id: row.id,
    scopeKey: row.scopeKey,
    appId: row.appId,
    agentSessionId: row.agentSessionId,
    conversationId: row.conversationId,
    threadId: row.threadId,
    runId: row.runId,
    state: row.state as LiveTurnState,
    pendingMessage: (row.pendingMessageJson ?? null) as Record<
      string,
      unknown
    > | null,
    stopAliasJids: Array.isArray(row.stopAliasJidsJson)
      ? (row.stopAliasJidsJson as string[])
      : [],
    requiredContinuationUserId: row.requiredContinuationUserId,
    retryCount: row.retryCount,
    nextCommandSeq: row.nextCommandSeq,
    workerInstanceId: row.workerInstanceId,
    leaseToken: row.leaseToken,
    fencingVersion: row.fencingVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
  };
}

export class PostgresLiveTurnRepository implements LiveTurnCoordinationRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly commandNotifier?: LiveTurnCommandNotifier,
    private readonly runtimeEvents: Pick<
      PostgresRuntimeEventRepository,
      'appendRuntimeEventWithExecutor'
    > = new PostgresRuntimeEventRepository(db),
    private readonly runtimeEventNotifier?: {
      notify(event: RuntimeEvent): Promise<void>;
    },
    private readonly liveAdmissionNotifier?: LiveAdmissionWorkItemNotifier,
  ) {}

  private async completeAgentRunAndAppendTerminalEvent(
    db: CanonicalExecutor,
    input: {
      runId: string;
      turnState: LiveTurnState;
      pendingMessage: Record<string, unknown> | null;
      completion: LiveTurnAgentRunCompletion;
      now: string;
    },
  ): Promise<TerminalRuntimePublication> {
    const runs = pgSchema.agentRunsPostgres;
    const runRows = await db
      .select({
        id: runs.id,
        appId: runs.appId,
        agentId: runs.agentId,
        sessionId: runs.sessionId,
        conversationId: runs.conversationId,
        threadId: runs.threadId,
        messageId: runs.messageId,
      })
      .from(runs)
      .where(eq(runs.id, input.runId))
      .limit(1);
    const run = runRows[0];
    if (!run) throw new Error(`Live turn agent run not found: ${input.runId}`);

    const route = appResponseRouteFromPendingMessage(input.pendingMessage);
    if (route && route.sessionId !== run.sessionId) {
      throw new Error(
        'Live turn app response route does not match the run session',
      );
    }
    const resultSummary =
      input.completion.resultSummary == null
        ? input.completion.resultSummary
        : redactProviderSessionHandlesInText(input.completion.resultSummary);
    const errorSummary =
      input.completion.errorSummary == null
        ? input.completion.errorSummary
        : redactProviderSessionHandlesInText(input.completion.errorSummary);
    await db
      .update(runs)
      .set({
        status: input.completion.status,
        endedAt: input.now,
        ...(resultSummary !== undefined ? { resultSummary } : {}),
        ...(errorSummary !== undefined ? { errorSummary } : {}),
      })
      .where(eq(runs.id, input.runId));
    const event = await this.runtimeEvents.appendRuntimeEventWithExecutor(db, {
      appId: run.appId as never,
      agentId: run.agentId as never,
      ...(run.sessionId ? { sessionId: run.sessionId as never } : {}),
      runId: run.id as never,
      ...(run.conversationId
        ? { conversationId: run.conversationId as never }
        : {}),
      ...(run.threadId ? { threadId: run.threadId as never } : {}),
      eventType:
        input.turnState === 'timed_out'
          ? RUNTIME_EVENT_TYPES.RUN_TIMEOUT
          : input.completion.status === 'completed'
            ? RUNTIME_EVENT_TYPES.RUN_COMPLETED
            : input.completion.status === 'canceled'
              ? RUNTIME_EVENT_TYPES.RUN_CANCELED
              : RUNTIME_EVENT_TYPES.RUN_FAILED,
      actor: 'runtime',
      correlationId: route?.correlationId ?? null,
      responseMode: route?.responseMode ?? 'none',
      webhookId: route?.webhookId ?? null,
      payload: {
        messageId: run.messageId ?? null,
        resultSummary: resultSummary ?? null,
        errorSummary: errorSummary ?? null,
      },
      createdAt: input.now as never,
    });
    const sdkTurn = run.messageId
      ? await settleSdkSessionTurnWithExecutor(db, {
          messageId: run.messageId,
          state:
            input.turnState === 'timed_out'
              ? 'timed_out'
              : input.completion.status === 'completed'
                ? 'completed'
                : input.completion.status === 'canceled'
                  ? 'canceled'
                  : 'failed',
          terminalCode:
            input.turnState === 'timed_out'
              ? 'execution_timeout'
              : input.completion.status === 'completed'
                ? null
                : input.completion.status === 'canceled'
                  ? 'canceled'
                  : 'agent_run_failed',
          now: input.now,
        })
      : null;
    return { event, sdkTurn };
  }

  private async notifyTerminalPublication(
    publication: TerminalRuntimePublication | null,
  ): Promise<void> {
    if (!publication) return;
    await Promise.allSettled([
      this.runtimeEventNotifier?.notify(publication.event),
      publication.sdkTurn
        ? this.liveAdmissionNotifier?.notifyLiveAdmissionWorkItem({
            appId: publication.sdkTurn.appId,
            workItemId: publication.sdkTurn.id,
          })
        : undefined,
    ]);
  }

  async enqueueLiveAdmissionWorkItem(
    input: EnqueueLiveAdmissionWorkItemInput,
  ): Promise<LiveAdmissionWorkItemEnqueueResult> {
    return enqueueLiveAdmissionWorkItem(this.db, input);
  }

  async claimLiveAdmissionWorkItems(
    input: LiveAdmissionClaimInput,
  ): Promise<LiveAdmissionWorkItem[]> {
    return claimLiveAdmissionWorkItems(this.db, input);
  }

  async renewLiveAdmissionWorkItemClaim(
    input: RenewLiveAdmissionWorkItemClaimInput,
  ): Promise<boolean> {
    return renewLiveAdmissionWorkItemClaim(this.db, input);
  }

  async deferLiveAdmissionWorkItem(input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    reason: 'queued_capacity' | 'listener_degraded' | 'retry';
    deferUntil: string;
    countFailure?: boolean;
    now?: string;
  }): Promise<boolean> {
    return deferLiveAdmissionWorkItem(this.db, input);
  }

  async settleLiveAdmissionWorkItem(input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    state: Extract<
      LiveAdmissionWorkItem['state'],
      'completed' | 'failed' | 'canceled'
    >;
    now?: string;
  }): Promise<boolean> {
    return settleLiveAdmissionWorkItem(this.db, input);
  }

  async rejectClaimedSdkSessionAdmission(input: {
    id: string;
    claimToken: string;
    workerInstanceId: string;
    code: string;
    retryable: boolean;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const result = await this.db.transaction(async (tx) => {
      const item = await settleLiveAdmissionWorkItemWithExecutor(tx, {
        id: input.id,
        claimToken: input.claimToken,
        workerInstanceId: input.workerInstanceId,
        state: 'failed',
        now,
      });
      if (!item) return { rejected: false, publication: null };
      if (!item.requestFingerprint) {
        throw new Error(
          'Claimed SDK admission is missing its request fingerprint.',
        );
      }
      const publication = await this.rejectSdkSessionTurnWithExecutor(tx, {
        messageId: item.messageId,
        state: 'failed',
        phase: 'admission',
        code: input.code,
        retryable: input.retryable,
        now,
      });
      if (!publication) {
        throw new Error('Claimed SDK admission turn was not waiting.');
      }
      return { rejected: true, publication };
    });
    await this.notifyTerminalPublication(result.publication);
    return result.rejected;
  }

  private async rejectSdkSessionTurnWithExecutor(
    db: CanonicalExecutor,
    input: {
      messageId: string;
      state: 'failed' | 'timed_out' | 'canceled';
      phase: 'queue' | 'admission';
      code: string;
      retryable: boolean;
      now: string;
    },
  ): Promise<TerminalRuntimePublication | null> {
    const sdkTurn = await settleSdkSessionTurnWithExecutor(db, {
      messageId: input.messageId,
      state: input.state,
      fromStates: ['waiting'],
      terminalCode: input.code,
      now: input.now,
    });
    if (!sdkTurn) return null;
    if (!sdkTurn.acceptedEventId || !sdkTurn.agentSessionId) {
      throw new Error('SDK session turn is missing its accepted-event link.');
    }
    const events = pgSchema.runtimeEventsPostgres;
    const acceptedRows = await db
      .select({
        correlationId: events.correlationId,
        responseMode: events.responseMode,
        webhookId: events.webhookId,
      })
      .from(events)
      .where(eq(events.eventId, sdkTurn.acceptedEventId))
      .limit(1);
    const accepted = acceptedRows[0];
    if (!accepted) {
      throw new Error('SDK session accepted event was not found.');
    }
    const event = await this.runtimeEvents.appendRuntimeEventWithExecutor(db, {
      appId: sdkTurn.appId as never,
      ...(sdkTurn.agentId ? { agentId: sdkTurn.agentId as never } : {}),
      sessionId: sdkTurn.agentSessionId as never,
      conversationId: sdkTurn.conversationId as never,
      ...(sdkTurn.threadId ? { threadId: sdkTurn.threadId as never } : {}),
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_REJECTED,
      actor: 'runtime',
      correlationId: accepted.correlationId,
      responseMode:
        (accepted.responseMode as 'sse' | 'webhook' | 'both' | 'none' | null) ??
        'none',
      webhookId: accepted.webhookId,
      payload: {
        messageId: sdkTurn.requestMessageId ?? sdkTurn.messageId,
        canonicalMessageId: sdkTurn.messageId,
        phase: input.phase,
        code: input.code,
        retryable: input.retryable,
      },
      createdAt: input.now as never,
    });
    return { event, sdkTurn };
  }

  async prepareSdkSessionTurn(input: {
    messageId: string;
    now?: string;
  }): Promise<LiveAdmissionWorkItem | null> {
    const now = input.now ?? currentIso();
    const result = await this.db.transaction(async (tx) => {
      const current = await findSdkSessionTurnWithExecutor(tx, input);
      if (
        current?.turnState === 'waiting' &&
        current.queueDeadlineAt &&
        Date.parse(current.queueDeadlineAt) <= Date.parse(now)
      ) {
        const publication = await this.rejectSdkSessionTurnWithExecutor(tx, {
          messageId: input.messageId,
          state: 'timed_out',
          phase: 'queue',
          code: 'queue_wait_timeout',
          retryable: true,
          now,
        });
        return {
          item:
            publication?.sdkTurn ??
            (await findSdkSessionTurnWithExecutor(tx, input)),
          publication,
        };
      }
      return { item: current, publication: null };
    });
    await this.notifyTerminalPublication(result.publication);
    return result.item;
  }

  async beginSdkSessionTurn(input: {
    messageId: string;
    now?: string;
  }): Promise<LiveAdmissionWorkItem | null> {
    const now = input.now ?? currentIso();
    const result = await this.db.transaction(async (tx) => {
      const current = await findSdkSessionTurnWithExecutor(tx, input);
      if (!current || current.turnState !== 'waiting') {
        return { item: current, publication: null };
      }
      if (
        current.queueDeadlineAt &&
        Date.parse(current.queueDeadlineAt) <= Date.parse(now)
      ) {
        const publication = await this.rejectSdkSessionTurnWithExecutor(tx, {
          messageId: input.messageId,
          state: 'timed_out',
          phase: 'queue',
          code: 'queue_wait_timeout',
          retryable: true,
          now,
        });
        return {
          item:
            publication?.sdkTurn ??
            (await findSdkSessionTurnWithExecutor(tx, input)),
          publication,
        };
      }
      if (!current.executionTimeoutMs || current.executionTimeoutMs < 1) {
        throw new Error('SDK session turn is missing its execution timeout.');
      }
      const executionDeadlineAt = new Date(
        Date.parse(now) + current.executionTimeoutMs,
      ).toISOString();
      const started = await markSdkSessionTurnRunningWithExecutor(tx, {
        messageId: input.messageId,
        executionDeadlineAt,
        now,
      });
      return {
        item: started ?? (await findSdkSessionTurnWithExecutor(tx, input)),
        publication: null,
      };
    });
    await this.notifyTerminalPublication(result.publication);
    return result.item;
  }

  async rejectSdkSessionTurn(input: {
    messageId: string;
    state: 'failed' | 'timed_out' | 'canceled';
    phase: 'queue' | 'admission';
    code: string;
    retryable: boolean;
    now?: string;
  }): Promise<LiveAdmissionWorkItem | null> {
    const result = await this.db.transaction((tx) =>
      this.rejectSdkSessionTurnWithExecutor(tx, {
        ...input,
        now: input.now ?? currentIso(),
      }),
    );
    await this.notifyTerminalPublication(result);
    return result?.sdkTurn ?? null;
  }

  async claimLiveTurn(input: {
    id: string;
    scope: LiveTurnScope;
    workerInstanceId: string;
    runId?: string | null;
    pendingMessage?: Record<string, unknown> | null;
    stopAliasJids?: string[];
    requiredContinuationUserId?: string | null;
    now?: string;
  }): Promise<LiveTurn | null> {
    const now = input.now ?? currentIso();
    const scopeKey = makeLiveTurnScopeKey(input.scope);
    const row: LiveTurnRow = {
      id: input.id,
      scopeKey,
      appId: input.scope.appId,
      agentSessionId: input.scope.agentSessionId ?? null,
      conversationId: input.scope.conversationId,
      threadId: input.scope.threadId ?? null,
      runId: input.runId ?? null,
      state: 'claimed',
      pendingMessageJson: input.pendingMessage ?? null,
      stopAliasJidsJson: input.stopAliasJids ?? [],
      requiredContinuationUserId: input.requiredContinuationUserId ?? null,
      retryCount: 0,
      nextCommandSeq: 1,
      workerInstanceId: input.workerInstanceId,
      leaseToken: null,
      fencingVersion: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    try {
      await this.db.insert(pgSchema.liveTurnsPostgres).values(row);
      return toLiveTurn(row);
    } catch (err) {
      // The partial unique index on (scope_key) where state is non-terminal
      // back-stops concurrent claims: the loser sees a unique violation.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async getActiveLiveTurn(input: {
    scope: LiveTurnScope;
  }): Promise<LiveTurn | null> {
    const scopeKey = makeLiveTurnScopeKey(input.scope);
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.scopeKey, scopeKey),
          notInArray(turns.state, TERMINAL_STATES),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toLiveTurn(row) : null;
  }

  async getLiveTurnById(id: string): Promise<LiveTurn | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.liveTurnsPostgres)
      .where(eq(pgSchema.liveTurnsPostgres.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toLiveTurn(row) : null;
  }

  async findActiveLiveTurnByStopAlias(input: {
    aliasJid: string;
  }): Promise<LiveTurn | null> {
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .select()
      .from(turns)
      .where(
        and(
          notInArray(turns.state, TERMINAL_STATES),
          sql`${turns.stopAliasJidsJson} @> ${JSON.stringify([
            input.aliasJid,
          ])}::jsonb`,
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toLiveTurn(row) : null;
  }

  async findActiveLiveTurnByRunId(input: {
    runId: string;
  }): Promise<LiveTurn | null> {
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.runId, input.runId),
          notInArray(turns.state, TERMINAL_STATES),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toLiveTurn(row) : null;
  }

  async transitionLiveTurnState(input: {
    id: string;
    toState: LiveTurnState;
    fromStates: LiveTurnState[];
    agentRunCompletion?: LiveTurnAgentRunCompletion | null;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    if (!input.agentRunCompletion) {
      const rows = await this.db
        .update(turns)
        .set({
          state: input.toState,
          updatedAt: now,
          ...(isTerminalLiveTurnState(input.toState) ? { endedAt: now } : {}),
        })
        .where(
          and(eq(turns.id, input.id), inArray(turns.state, input.fromStates)),
        )
        .returning({ id: turns.id });
      return rows.length > 0;
    }
    const completion = input.agentRunCompletion;
    const result = await this.db.transaction(async (tx) => {
      const turnRows = await tx
        .select({
          id: turns.id,
          runId: turns.runId,
          state: turns.state,
          pendingMessage: turns.pendingMessageJson,
        })
        .from(turns)
        .where(eq(turns.id, input.id))
        .for('update');
      const turn = turnRows[0];
      if (!turn || !input.fromStates.includes(turn.state as LiveTurnState)) {
        return { transitioned: false, publication: null };
      }
      const rows = await tx
        .update(turns)
        .set({
          state: input.toState,
          updatedAt: now,
          ...(isTerminalLiveTurnState(input.toState) ? { endedAt: now } : {}),
        })
        .where(eq(turns.id, input.id))
        .returning({ id: turns.id });
      if (rows.length === 0) {
        return { transitioned: false, publication: null };
      }
      let publication: TerminalRuntimePublication | null = null;
      if (turn.runId) {
        publication = await this.completeAgentRunAndAppendTerminalEvent(tx, {
          runId: turn.runId,
          turnState: input.toState,
          pendingMessage: (turn.pendingMessage ?? null) as Record<
            string,
            unknown
          > | null,
          completion,
          now,
        });
        await redactTerminalToolPayloads(tx, {
          runId: turn.runId,
          liveTurnId: input.id,
        });
      }
      return { transitioned: true, publication };
    });
    await this.notifyTerminalPublication(result.publication);
    return result.transitioned;
  }

  async attachLiveTurnLease(input: {
    id: string;
    runId: string;
    lease: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(turns)
      .set({
        runId: input.runId,
        workerInstanceId: input.lease.workerInstanceId,
        leaseToken: input.lease.leaseToken,
        fencingVersion: input.lease.fencingVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(turns.id, input.id),
          eq(turns.state, 'claimed'),
          isNull(turns.leaseToken),
        ),
      )
      .returning({ id: turns.id });
    return rows.length > 0;
  }

  async updateLiveTurnRouting(input: {
    id: string;
    fence: LiveTurnLeaseFence;
    stopAliasJids?: string[];
    requiredContinuationUserId?: string | null;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    const updateValues: {
      stopAliasJidsJson?: string[];
      requiredContinuationUserId?: string | null;
      updatedAt: string;
    } = {
      updatedAt: now,
    };
    if (input.stopAliasJids !== undefined) {
      updateValues.stopAliasJidsJson = input.stopAliasJids;
    }
    if (input.requiredContinuationUserId !== undefined) {
      updateValues.requiredContinuationUserId =
        input.requiredContinuationUserId?.trim() || null;
    }
    const rows = await this.db
      .update(turns)
      .set(updateValues)
      .where(
        and(
          eq(turns.id, input.id),
          notInArray(turns.state, TERMINAL_STATES),
          activeRunLeaseFence({
            runId: sql`${turns.runId}`,
            fence: input.fence,
            now,
          }),
        ),
      )
      .returning({ id: turns.id });
    return rows.length > 0;
  }

  async transitionLiveTurnStateFenced(input: {
    id: string;
    toState: LiveTurnState;
    fromStates: LiveTurnState[];
    fence: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(turns)
      .set({
        state: input.toState,
        updatedAt: now,
        ...(isTerminalLiveTurnState(input.toState) ? { endedAt: now } : {}),
      })
      .where(
        and(
          eq(turns.id, input.id),
          inArray(turns.state, input.fromStates),
          activeRunLeaseFence({
            runId: sql`${turns.runId}`,
            fence: input.fence,
            now,
          }),
        ),
      )
      .returning({ id: turns.id });
    return rows.length > 0;
  }

  async finalizeLiveTurnWithLease(input: {
    id: string;
    turnState: Extract<LiveTurnState, 'completed' | 'failed' | 'timed_out'>;
    leaseOutcome: 'completed' | 'failed' | 'released';
    fence: LiveTurnLeaseFence;
    agentRunCompletion?: LiveTurnAgentRunCompletion | null;
    requireNoPendingCommands?: boolean;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const result = await this.db.transaction(async (tx) => {
      const turns = pgSchema.liveTurnsPostgres;
      const turnRows = await tx
        .select({
          id: turns.id,
          runId: turns.runId,
          state: turns.state,
          pendingMessage: turns.pendingMessageJson,
        })
        .from(turns)
        .where(eq(turns.id, input.id))
        .for('update');
      const turn = turnRows[0];
      if (!turn?.runId) return { finalized: false, publication: null };
      if (isTerminalLiveTurnState(turn.state as LiveTurnState)) {
        return { finalized: false, publication: null };
      }
      if (input.requireNoPendingCommands) {
        const commands = pgSchema.liveTurnCommandsPostgres;
        const pendingCommands = await tx
          .select({ id: commands.id })
          .from(commands)
          .where(
            and(
              eq(commands.liveTurnId, input.id),
              eq(commands.status, 'pending'),
            ),
          )
          .limit(1);
        if (pendingCommands.length > 0) {
          await settleRunLeaseTx(tx, {
            runId: turn.runId,
            leaseToken: input.fence.leaseToken,
            workerInstanceId: input.fence.workerInstanceId,
            fencingVersion: input.fence.fencingVersion,
            outcome: 'released',
          });
          return { finalized: false, publication: null };
        }
      }
      const settled = await settleRunLeaseTx(tx, {
        runId: turn.runId,
        leaseToken: input.fence.leaseToken,
        workerInstanceId: input.fence.workerInstanceId,
        fencingVersion: input.fence.fencingVersion,
        outcome: input.leaseOutcome,
      });
      if (!settled) return { finalized: false, publication: null };
      let publication: TerminalRuntimePublication | null = null;
      if (input.agentRunCompletion) {
        publication = await this.completeAgentRunAndAppendTerminalEvent(tx, {
          runId: turn.runId,
          turnState: input.turnState,
          pendingMessage: (turn.pendingMessage ?? null) as Record<
            string,
            unknown
          > | null,
          completion: input.agentRunCompletion,
          now,
        });
        await redactTerminalToolPayloads(tx, {
          runId: turn.runId,
          liveTurnId: input.id,
        });
      }
      await tx
        .update(turns)
        .set({ state: input.turnState, updatedAt: now, endedAt: now })
        .where(eq(turns.id, input.id));
      return { finalized: true, publication };
    });
    await this.notifyTerminalPublication(result.publication);
    return result.finalized;
  }

  async takeOverLiveTurn(input: {
    id: string;
    lease: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(turns)
      .set({
        state: 'recovered',
        workerInstanceId: input.lease.workerInstanceId,
        leaseToken: input.lease.leaseToken,
        fencingVersion: input.lease.fencingVersion,
        retryCount: sql`${turns.retryCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(turns.id, input.id),
          notInArray(turns.state, TERMINAL_STATES),
          // The takeover lease must outrank whatever the turn last saw; the
          // run lease claim already serialized recovery, this guards replays.
          or(
            isNull(turns.fencingVersion),
            sql`${turns.fencingVersion} < ${input.lease.fencingVersion}`,
          ),
        ),
      )
      .returning({ id: turns.id });
    return rows.length > 0;
  }

  async listRecoverableLiveTurns(input: {
    unleasedStaleBefore: string;
    limit: number;
    now?: string;
  }): Promise<LiveTurn[]> {
    const now = input.now ?? currentIso();
    const limit = Math.max(1, Math.floor(input.limit));
    const candidateLimit = limit * 4;
    const turns = pgSchema.liveTurnsPostgres;
    const leases = pgSchema.runLeasesPostgres;
    const lostOwnerCandidates = await this.db
      .select({ id: turns.id, updatedAt: turns.updatedAt })
      .from(turns)
      .where(
        and(
          notInArray(turns.state, TERMINAL_STATES),
          // Owner lost: the turn has a run but no live lease for it.
          sql`${turns.runId} IS NOT NULL`,
          sql`${turns.leaseToken} IS NOT NULL`,
          sql`${turns.fencingVersion} IS NOT NULL`,
          sql`NOT EXISTS (
                SELECT 1 FROM ${leases}
                WHERE ${leases.runId} = ${turns.runId}
                  AND ${leases.status} = 'active'
                  AND ${leases.expiresAt} > ${now}
              )`,
        ),
      )
      .orderBy(asc(turns.updatedAt))
      .limit(candidateLimit);
    const unleasedCandidates = await this.db
      .select({ id: turns.id, updatedAt: turns.updatedAt })
      .from(turns)
      .where(
        and(
          notInArray(turns.state, TERMINAL_STATES),
          // Never leased: the claim crashed before lease attach.
          isNull(turns.leaseToken),
          lte(turns.updatedAt, input.unleasedStaleBefore),
        ),
      )
      .orderBy(asc(turns.updatedAt))
      .limit(candidateLimit);
    const candidateIds = [...lostOwnerCandidates, ...unleasedCandidates]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, limit)
      .map((candidate) => candidate.id);
    if (candidateIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(turns)
      .where(inArray(turns.id, candidateIds));
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return candidateIds
      .map((id) => rowsById.get(id))
      .filter((row): row is LiveTurnRow => row !== undefined)
      .map(toLiveTurn);
  }

  async getOldestWaitingLiveAdmission(input: {
    conversationJids: string[];
    now?: string;
  }): Promise<{
    conversationJid: string;
    threadId: string | null;
    waitingSince: string;
    ageSeconds: number;
  } | null> {
    return queryOldestWaitingLiveAdmission(this.db, input);
  }

  async appendLiveTurnCommand(input: AppendLiveTurnCommandInput) {
    return appendLiveTurnCommandRow(this.db, this.commandNotifier, input);
  }

  async listPendingLiveTurnCommands(input: {
    liveTurnId: string;
    limit: number;
  }): Promise<LiveTurnCommand[]> {
    const commands = pgSchema.liveTurnCommandsPostgres;
    const rows = await this.db
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.liveTurnId, input.liveTurnId),
          eq(commands.status, 'pending'),
        ),
      )
      .orderBy(asc(commands.seq))
      .limit(Math.max(1, Math.floor(input.limit)));
    return rows.map(toLiveTurnCommand);
  }

  async isLiveTurnCommandFenceActive(input: {
    id: string;
    fence: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const commands = pgSchema.liveTurnCommandsPostgres;
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .select({ id: commands.id })
      .from(commands)
      .where(
        and(
          eq(commands.id, input.id),
          eq(commands.status, 'pending'),
          activeRunLeaseFence({
            runId: sql`(SELECT ${turns.runId} FROM ${turns} WHERE ${turns.id} = ${commands.liveTurnId})`,
            fence: input.fence,
            now,
          }),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async markLiveTurnCommandApplied(input: {
    id: string;
    appliedByWorkerId: string;
    fence?: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const commands = pgSchema.liveTurnCommandsPostgres;
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(commands)
      .set({
        status: 'applied',
        appliedByWorkerId: input.appliedByWorkerId,
        appliedAt: now,
      })
      .where(
        and(
          eq(commands.id, input.id),
          eq(commands.status, 'pending'),
          input.fence
            ? activeRunLeaseFence({
                runId: sql`(SELECT ${turns.runId} FROM ${turns} WHERE ${turns.id} = ${commands.liveTurnId})`,
                fence: input.fence,
                now,
              })
            : undefined,
        ),
      )
      .returning({ id: commands.id });
    return rows.length > 0;
  }

  async markLiveTurnCommandRejected(input: {
    id: string;
    reason: string;
    fence?: LiveTurnLeaseFence;
    now?: string;
  }): Promise<boolean> {
    const now = input.now ?? currentIso();
    const commands = pgSchema.liveTurnCommandsPostgres;
    const turns = pgSchema.liveTurnsPostgres;
    const rows = await this.db
      .update(commands)
      .set({
        status: 'rejected',
        rejectedReason: input.reason,
        appliedAt: now,
      })
      .where(
        and(
          eq(commands.id, input.id),
          eq(commands.status, 'pending'),
          input.fence
            ? activeRunLeaseFence({
                runId: sql`(SELECT ${turns.runId} FROM ${turns} WHERE ${turns.id} = ${commands.liveTurnId})`,
                fence: input.fence,
                now,
              })
            : undefined,
        ),
      )
      .returning({ id: commands.id });
    return rows.length > 0;
  }
}
