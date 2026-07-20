import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { nowMs, toIso } from '@core/shared/time/datetime.js';
import {
  linkSdkSessionAcceptedEventWithExecutor,
  markSdkSessionTurnRunningWithExecutor,
  preflightSdkSessionAdmissionWithExecutor,
  promoteSdkSessionAdmissionWithExecutor,
  settleSdkSessionTurnWithExecutor,
} from '@core/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.js';
import { PostgresLiveTurnRepository } from '@core/adapters/storage/postgres/repositories/live-turn-repository.postgres.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('live admission work items (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let liveTurns: PostgresIntegrationRuntime['repositories']['liveTurns'];

  const base = {
    appId: 'default',
    agentSessionId: 'session-live-admission',
    conversationId: 'tg:live-admission',
    threadId: null,
    queueJid: 'tg:live-admission',
    messageId: 'message:tg:live-admission:msg-1',
    messageCursor: '2026-06-16T00:00:00.000Z::msg-1',
    idempotencyKey: 'telegram:delivery:msg-1',
  };

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_admission',
    });
    liveTurns = runtime.repositories.liveTurns;
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  async function registerSdkSessionScope(input: {
    appId: string;
    agentSessionId: string;
    conversationId: string;
  }): Promise<void> {
    const createdAt = toIso(nowMs());
    const agentId = `agent:${input.appId}:sdk-test`;
    await runtime.service.pool.query(
      `INSERT INTO apps (id, slug, name, status, created_at, updated_at)
       VALUES ($1, $1, $1, 'active', $2, $2)`,
      [input.appId, createdAt],
    );
    await runtime.service.pool.query(
      `INSERT INTO agents (id, app_id, name, status, created_at, updated_at)
       VALUES ($1, $2, $1, 'active', $3, $3)`,
      [agentId, input.appId, createdAt],
    );
    await runtime.service.pool.query(
      `INSERT INTO conversations (
         id, app_id, provider_account_id, external_ref_json, kind, status,
         created_at, updated_at
       ) VALUES ($1, $2, 'provider:sdk-test', '{}', 'direct', 'active', $3, $3)`,
      [input.conversationId, input.appId, createdAt],
    );
    await runtime.repositories.agentSessions.saveAgentSession({
      id: input.agentSessionId as never,
      appId: input.appId as never,
      agentId: agentId as never,
      conversationId: input.conversationId as never,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
    });
  }

  it('deduplicates provider delivery by idempotency key', async () => {
    const first = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-1',
      ...base,
      triggerDecision: { requiresTrigger: false },
      now: toIso(nowMs() - 10_000),
    });
    expect(first.outcome).toBe('enqueued');
    expect(first.item).toMatchObject({
      id: 'admission-1',
      state: 'queued',
      sourceKind: 'message',
      triggerDecision: { requiresTrigger: false },
    });

    const replay = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-duplicate',
      ...base,
    });
    expect(replay.outcome).toBe('replayed');
    expect(replay.item.id).toBe('admission-1');
  });

  it('deduplicates provider delivery by deterministic work item id', async () => {
    const first = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-id-replay',
      ...base,
      appId: 'app-id-replay',
      messageId: 'message:tg:live-admission:id-replay',
      messageCursor: '2026-06-16T00:00:00.500Z::id-replay',
      idempotencyKey: 'telegram:delivery:id-replay:root',
      now: toIso(nowMs() - 9_500),
    });
    expect(first.outcome).toBe('enqueued');

    const replay = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-id-replay',
      ...base,
      appId: 'app-id-replay',
      messageId: 'message:tg:live-admission:id-replay',
      messageCursor: '2026-06-16T00:00:00.500Z::id-replay',
      idempotencyKey: 'telegram:delivery:id-replay:thread',
    });

    expect(replay.outcome).toBe('replayed');
    expect(replay.item).toMatchObject({
      id: 'admission-id-replay',
      idempotencyKey: 'telegram:delivery:id-replay:root',
    });
  });

  it('reserves and replays one fingerprinted SDK-session turn with stable ids', async () => {
    const sdkBase = {
      id: 'sdk-admission-1',
      appId: 'sdk-admission-app',
      agentSessionId: 'sdk-admission-session',
      conversationId: 'app:sdk-admission-app:conversation',
      threadId: 'thread-1',
      queueJid: 'app:sdk-admission-app:conversation::thread-1',
      messageId: 'message:app:sdk-admission-app:conversation:sdk-message-1',
      requestMessageId: 'sdk-message-1',
      messageCursor: '2026-07-20T00:00:00.000Z::sdk-message-1',
      idempotencyKey: 'teams-activity-1',
      requestFingerprint: 'fingerprint-1',
      queuePolicy: {
        maxWaitingMessages: 3,
        maxQueueWaitMs: 90_000,
        executionTimeoutMs: 90_000,
      },
      now: '2026-07-20T00:00:00.000Z',
    };
    const reserved = await runtime.service.db.transaction(async (tx) => {
      const preflight = await preflightSdkSessionAdmissionWithExecutor(tx, {
        appId: sdkBase.appId,
        agentSessionId: sdkBase.agentSessionId,
        idempotencyKey: sdkBase.idempotencyKey,
        requestFingerprint: sdkBase.requestFingerprint,
        queuePolicy: sdkBase.queuePolicy,
        now: sdkBase.now,
      });
      expect(preflight.outcome).toBe('available');
      if (preflight.outcome !== 'available')
        throw new Error('expected preflight');
      return promoteSdkSessionAdmissionWithExecutor(tx, {
        ...sdkBase,
        preflight: preflight.preflight,
      });
    });
    expect(reserved).toMatchObject({
      outcome: 'enqueued',
      item: {
        id: 'sdk-admission-1',
        messageId: 'message:app:sdk-admission-app:conversation:sdk-message-1',
        requestMessageId: 'sdk-message-1',
        requestFingerprint: 'fingerprint-1',
        turnState: 'waiting',
        queueDeadlineAt: '2026-07-20T00:01:30.000Z',
        executionTimeoutMs: 90_000,
      },
    });

    const event = await runtime.storageRuntime.runtimeEvents.publish({
      appId: 'default' as never,
      eventType: RUNTIME_EVENT_TYPES.WEBHOOK_TEST,
      actor: 'test',
      payload: { source: 'sdk-session-admission-test' },
    });
    const linked = await runtime.service.db.transaction((tx) =>
      linkSdkSessionAcceptedEventWithExecutor(tx, {
        id: 'sdk-admission-1',
        acceptedEventId: event.eventId,
      }),
    );
    expect(linked?.acceptedEventId).toBe(event.eventId);

    const replay = await runtime.service.db.transaction((tx) =>
      preflightSdkSessionAdmissionWithExecutor(tx, {
        appId: sdkBase.appId,
        agentSessionId: sdkBase.agentSessionId,
        idempotencyKey: sdkBase.idempotencyKey,
        requestFingerprint: sdkBase.requestFingerprint,
        queuePolicy: sdkBase.queuePolicy,
      }),
    );
    expect(replay).toMatchObject({
      outcome: 'replayed',
      item: {
        id: 'sdk-admission-1',
        requestMessageId: 'sdk-message-1',
        acceptedEventId: event.eventId,
      },
    });

    const conflict = await runtime.service.db.transaction((tx) =>
      preflightSdkSessionAdmissionWithExecutor(tx, {
        appId: sdkBase.appId,
        agentSessionId: sdkBase.agentSessionId,
        idempotencyKey: sdkBase.idempotencyKey,
        requestFingerprint: 'fingerprint-changed',
        queuePolicy: sdkBase.queuePolicy,
      }),
    );
    expect(conflict.outcome).toBe('fingerprint_conflict');
  });

  it('atomically caps an SDK session at one active plus three waiting turns', async () => {
    const appId = 'sdk-cap-app';
    const agentSessionId = 'sdk-cap-session';
    const reserve = (ordinal: number) =>
      runtime.service.db.transaction(async (tx) => {
        const now = `2026-07-20T00:00:0${ordinal}.000Z`;
        const preflight = await preflightSdkSessionAdmissionWithExecutor(tx, {
          appId,
          agentSessionId,
          idempotencyKey: `teams-activity-${ordinal}`,
          requestFingerprint: `fingerprint-${ordinal}`,
          queuePolicy: {
            maxWaitingMessages: 3,
            maxQueueWaitMs: 90_000,
            executionTimeoutMs: 90_000,
          },
          now,
        });
        if (preflight.outcome !== 'available') return preflight;
        const promoted = await promoteSdkSessionAdmissionWithExecutor(tx, {
          id: `sdk-cap-admission-${ordinal}`,
          appId,
          agentSessionId,
          conversationId: `app:${appId}:conversation`,
          queueJid: `app:${appId}:conversation`,
          messageId: `message:app:${appId}:conversation:sdk-cap-message-${ordinal}`,
          requestMessageId: `sdk-cap-message-${ordinal}`,
          messageCursor: `${now}::sdk-cap-message-${ordinal}`,
          preflight: preflight.preflight,
          now,
        });
        return { outcome: 'promoted' as const, item: promoted.item };
      });

    const concurrent = await Promise.all([1, 2, 3, 4, 5].map(reserve));
    expect(
      concurrent.filter((result) => result.outcome === 'promoted'),
    ).toHaveLength(4);
    expect(
      concurrent.filter((result) => result.outcome === 'capacity_exceeded'),
    ).toEqual([
      { outcome: 'capacity_exceeded', activeAndWaiting: 4, capacity: 4 },
    ]);

    const running = await runtime.service.db.transaction((tx) =>
      markSdkSessionTurnRunningWithExecutor(tx, {
        messageId: 'message:app:sdk-cap-app:conversation:sdk-cap-message-1',
        executionDeadlineAt: '2026-07-20T00:01:31.000Z',
        now: '2026-07-20T00:00:01.000Z',
      }),
    );
    expect(running?.turnState).toBe('running');
    const settled = await runtime.service.db.transaction((tx) =>
      settleSdkSessionTurnWithExecutor(tx, {
        messageId: 'message:app:sdk-cap-app:conversation:sdk-cap-message-1',
        state: 'completed',
        terminalCode: 'completed',
        now: '2026-07-20T00:00:02.000Z',
      }),
    );
    expect(settled).toMatchObject({
      turnState: 'completed',
      terminalCode: 'completed',
    });
    await expect(reserve(6)).resolves.toMatchObject({ outcome: 'promoted' });
  });

  it('claims only the head SDK turn and releases the next turn after terminal settlement', async () => {
    const appId = 'sdk-serialized-app';
    const agentSessionId = 'sdk-serialized-session';
    const conversationId = 'conversation:sdk-serialized';
    await registerSdkSessionScope({ appId, agentSessionId, conversationId });
    const now = toIso(nowMs());
    const reserve = async (ordinal: number) => {
      const messageId = `message:app:default:serialized-${ordinal}`;
      const result = await runtime.service.db.transaction(async (tx) => {
        const preflight = await preflightSdkSessionAdmissionWithExecutor(tx, {
          appId,
          agentSessionId,
          idempotencyKey: `serialized-${ordinal}`,
          requestFingerprint: `serialized-fingerprint-${ordinal}`,
          queuePolicy: {
            maxWaitingMessages: 3,
            maxQueueWaitMs: 90_000,
            executionTimeoutMs: 90_000,
          },
          now: toIso(Date.parse(now) + ordinal),
        });
        if (preflight.outcome !== 'available') {
          throw new Error('Expected serialized SDK preflight');
        }
        return promoteSdkSessionAdmissionWithExecutor(tx, {
          id: `sdk-serialized-admission-${ordinal}`,
          appId,
          agentSessionId,
          conversationId,
          queueJid: conversationId,
          messageId,
          requestMessageId: `serialized-${ordinal}`,
          messageCursor: `${toIso(Date.parse(now) + ordinal)}::serialized-${ordinal}`,
          preflight: preflight.preflight,
        });
      });
      const accepted = await runtime.storageRuntime.runtimeEvents.publish({
        appId: appId as never,
        sessionId: agentSessionId as never,
        eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
        actor: 'sdk',
        correlationId: `serialized-correlation-${ordinal}`,
        responseMode: 'sse',
        payload: { messageId: `serialized-${ordinal}` },
      });
      await runtime.service.db.transaction((tx) =>
        linkSdkSessionAcceptedEventWithExecutor(tx, {
          id: result.item.id,
          acceptedEventId: accepted.eventId,
        }),
      );
      return result.item;
    };

    const first = await reserve(1);
    const second = await reserve(2);
    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId,
      workerInstanceId: 'sdk-serialized-worker-1',
      claimToken: 'sdk-serialized-claim-1',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 100,
    });
    const serializedClaims = claimed.filter(
      (item) => item.agentSessionId === agentSessionId,
    );
    expect(serializedClaims.map((item) => item.id)).toEqual([first.id]);
    await liveTurns.settleLiveAdmissionWorkItem({
      id: first.id,
      workerInstanceId: 'sdk-serialized-worker-1',
      claimToken: 'sdk-serialized-claim-1',
      state: 'completed',
    });
    await runtime.service.db.transaction((tx) =>
      settleSdkSessionTurnWithExecutor(tx, {
        messageId: first.messageId,
        state: 'completed',
      }),
    );

    const released = await liveTurns.claimLiveAdmissionWorkItems({
      appId,
      workerInstanceId: 'sdk-serialized-worker-2',
      claimToken: 'sdk-serialized-claim-2',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 100,
    });
    expect(released.map((item) => item.id)).toContain(second.id);
    await liveTurns.settleLiveAdmissionWorkItem({
      id: second.id,
      workerInstanceId: 'sdk-serialized-worker-2',
      claimToken: 'sdk-serialized-claim-2',
      state: 'completed',
    });
  });

  it('durably rejects an expired SDK queue entry with a typed event', async () => {
    const appId = 'sdk-queue-expired-app';
    const agentSessionId = 'sdk-queue-expired-session';
    const conversationId = 'conversation:sdk-queue-expired';
    await registerSdkSessionScope({ appId, agentSessionId, conversationId });
    const messageId = 'message:app:default:queue-expired';
    const acceptedAt = toIso(nowMs() - 120_000);
    const reserved = await runtime.service.db.transaction(async (tx) => {
      const preflight = await preflightSdkSessionAdmissionWithExecutor(tx, {
        appId,
        agentSessionId,
        idempotencyKey: 'sdk-queue-expired',
        requestFingerprint: 'sdk-queue-expired-fingerprint',
        queuePolicy: {
          maxWaitingMessages: 3,
          maxQueueWaitMs: 1_000,
          executionTimeoutMs: 90_000,
        },
        now: acceptedAt,
      });
      if (preflight.outcome !== 'available') {
        throw new Error('Expected expired SDK preflight');
      }
      return promoteSdkSessionAdmissionWithExecutor(tx, {
        id: 'sdk-queue-expired-admission',
        appId,
        agentSessionId,
        conversationId,
        queueJid: conversationId,
        messageId,
        requestMessageId: 'sdk-queue-expired',
        messageCursor: `${acceptedAt}::sdk-queue-expired`,
        preflight: preflight.preflight,
      });
    });
    const accepted = await runtime.storageRuntime.runtimeEvents.publish({
      appId: appId as never,
      sessionId: agentSessionId as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
      actor: 'sdk',
      correlationId: 'sdk-queue-expired-correlation',
      responseMode: 'sse',
      payload: { messageId: 'sdk-queue-expired' },
    });
    await runtime.service.db.transaction((tx) =>
      linkSdkSessionAcceptedEventWithExecutor(tx, {
        id: reserved.item.id,
        acceptedEventId: accepted.eventId,
      }),
    );

    await expect(
      liveTurns.prepareSdkSessionTurn?.({ messageId }),
    ).resolves.toMatchObject({
      turnState: 'timed_out',
      terminalCode: 'queue_wait_timeout',
    });
    const events = await runtime.repositories.runtimeEvents.listRuntimeEvents({
      appId: appId as never,
      sessionId: agentSessionId as never,
      eventTypes: [RUNTIME_EVENT_TYPES.SESSION_MESSAGE_REJECTED],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        correlationId: 'sdk-queue-expired-correlation',
        payload: expect.objectContaining({
          messageId: 'sdk-queue-expired',
          canonicalMessageId: messageId,
          phase: 'queue',
          code: 'queue_wait_timeout',
          retryable: true,
        }),
      }),
    );
  });

  it('atomically rejects a claimed SDK admission and rolls back on event failure', async () => {
    const appId = 'sdk-admission-rejection-app';
    const agentSessionId = 'sdk-admission-rejection-session';
    const conversationId = 'conversation:sdk-admission-rejection';
    const messageId = 'message:app:default:admission-rejection';
    const itemId = 'sdk-admission-rejection-item';
    const claimToken = 'sdk-admission-rejection-claim';
    const workerInstanceId = 'sdk-admission-rejection-worker';
    const acceptedAt = toIso(nowMs());
    await registerSdkSessionScope({ appId, agentSessionId, conversationId });
    const reserved = await runtime.service.db.transaction(async (tx) => {
      const preflight = await preflightSdkSessionAdmissionWithExecutor(tx, {
        appId,
        agentSessionId,
        idempotencyKey: 'sdk-admission-rejection',
        requestFingerprint: 'sdk-admission-rejection-fingerprint',
        queuePolicy: {
          maxWaitingMessages: 3,
          maxQueueWaitMs: 90_000,
          executionTimeoutMs: 90_000,
        },
        now: acceptedAt,
      });
      if (preflight.outcome !== 'available') {
        throw new Error('Expected SDK admission rejection preflight');
      }
      return promoteSdkSessionAdmissionWithExecutor(tx, {
        id: itemId,
        appId,
        agentSessionId,
        conversationId,
        queueJid: conversationId,
        messageId,
        requestMessageId: 'sdk-admission-rejection',
        messageCursor: `${acceptedAt}::sdk-admission-rejection`,
        preflight: preflight.preflight,
      });
    });
    const accepted = await runtime.storageRuntime.runtimeEvents.publish({
      appId: appId as never,
      sessionId: agentSessionId as never,
      conversationId: conversationId as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
      actor: 'sdk',
      correlationId: 'sdk-admission-rejection-correlation',
      responseMode: 'sse',
      payload: { messageId: 'sdk-admission-rejection' },
    });
    await runtime.service.db.transaction((tx) =>
      linkSdkSessionAcceptedEventWithExecutor(tx, {
        id: reserved.item.id,
        acceptedEventId: accepted.eventId,
      }),
    );
    await liveTurns.claimLiveAdmissionWorkItems({
      appId,
      workerInstanceId,
      claimToken,
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
    });

    const eventFailure = new Error('SDK admission rejection event failed');
    const failingLiveTurns = new PostgresLiveTurnRepository(
      runtime.service.db,
      undefined,
      {
        appendRuntimeEventWithExecutor: async () => {
          throw eventFailure;
        },
      } as never,
    );
    await expect(
      failingLiveTurns.rejectClaimedSdkSessionAdmission({
        id: itemId,
        claimToken,
        workerInstanceId,
        code: 'admission_failed',
        retryable: true,
      }),
    ).rejects.toThrow(eventFailure);
    const rolledBack = await runtime.service.pool.query<{
      state: string;
      turn_state: string;
    }>(
      `SELECT state, turn_state FROM live_admission_work_items WHERE id = $1`,
      [itemId],
    );
    expect(rolledBack.rows[0]).toEqual({
      state: 'claimed',
      turn_state: 'waiting',
    });

    await expect(
      liveTurns.rejectClaimedSdkSessionAdmission?.({
        id: itemId,
        claimToken,
        workerInstanceId,
        code: 'admission_failed',
        retryable: true,
      }),
    ).resolves.toBe(true);
    const settled = await runtime.service.pool.query<{
      state: string;
      turn_state: string;
      terminal_code: string;
    }>(
      `SELECT state, turn_state, terminal_code FROM live_admission_work_items WHERE id = $1`,
      [itemId],
    );
    expect(settled.rows[0]).toEqual({
      state: 'failed',
      turn_state: 'failed',
      terminal_code: 'admission_failed',
    });
    const events = await runtime.repositories.runtimeEvents.listRuntimeEvents({
      appId: appId as never,
      sessionId: agentSessionId as never,
      eventTypes: [RUNTIME_EVENT_TYPES.SESSION_MESSAGE_REJECTED],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      correlationId: 'sdk-admission-rejection-correlation',
      payload: expect.objectContaining({
        messageId: 'sdk-admission-rejection',
        canonicalMessageId: messageId,
        phase: 'admission',
        code: 'admission_failed',
        retryable: true,
      }),
    });
    await expect(
      liveTurns.rejectClaimedSdkSessionAdmission?.({
        id: itemId,
        claimToken,
        workerInstanceId,
        code: 'admission_failed',
        retryable: true,
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.repositories.runtimeEvents.listRuntimeEvents({
        appId: appId as never,
        sessionId: agentSessionId as never,
        eventTypes: [RUNTIME_EVENT_TYPES.SESSION_MESSAGE_REJECTED],
      }),
    ).resolves.toHaveLength(1);
  });

  it('claims due rows in durable FIFO order without prompt text payloads', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-2',
      ...base,
      messageId: 'message:tg:live-admission:msg-2',
      messageCursor: '2026-06-16T00:00:01.000Z::msg-2',
      idempotencyKey: 'telegram:delivery:msg-2',
      now: toIso(nowMs() - 9_000),
    });

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-1',
      claimToken: 'claim-token-1',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });

    expect(claimed.map((item) => item.id)).toEqual([
      'admission-1',
      'admission-2',
    ]);
    expect(claimed[0]).toMatchObject({
      state: 'claimed',
      claimWorkerInstanceId: 'worker-1',
      claimToken: 'claim-token-1',
      fencingVersion: 1,
      retryCount: 1,
      failureCount: 0,
    });
    expect(JSON.stringify(claimed)).not.toContain('hello');
    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-2',
        claimToken: 'claim-token-1',
        workerInstanceId: 'worker-1',
        state: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('defers capacity-limited claims and reclaims them only when due', async () => {
    const deferred = await liveTurns.deferLiveAdmissionWorkItem({
      id: 'admission-1',
      claimToken: 'claim-token-1',
      workerInstanceId: 'worker-1',
      reason: 'queued_capacity',
      deferUntil: toIso(nowMs() + 60_000),
    });
    expect(deferred).toBe(true);

    await expect(
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-2',
        claimToken: 'claim-token-2',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 10,
      }),
    ).resolves.toEqual([]);

    const reclaimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-2',
      claimToken: 'claim-token-2',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
      now: toIso(nowMs() + 120_000),
    });

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      id: 'admission-1',
      state: 'claimed',
      claimWorkerInstanceId: 'worker-2',
      claimToken: 'claim-token-2',
      deferredReason: null,
      fencingVersion: 2,
      retryCount: 2,
      failureCount: 0,
    });
  });

  it('counts real processing failures separately from claim attempts', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-failure-count',
      ...base,
      messageId: 'message:tg:live-admission:failure-count',
      messageCursor: '2026-06-16T00:00:01.500Z::failure-count',
      idempotencyKey: 'telegram:delivery:failure-count',
      now: toIso(nowMs() - 8_000),
    });
    const [claimed] = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-failure-count',
      claimToken: 'claim-token-failure-count',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
    });
    expect(claimed).toMatchObject({
      id: 'admission-failure-count',
      retryCount: 1,
      failureCount: 0,
    });

    await expect(
      liveTurns.deferLiveAdmissionWorkItem({
        id: 'admission-failure-count',
        claimToken: 'claim-token-failure-count',
        workerInstanceId: 'worker-failure-count',
        reason: 'listener_degraded',
        deferUntil: toIso(nowMs() - 1_000),
        countFailure: true,
      }),
    ).resolves.toBe(true);

    const [reclaimed] = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-failure-count-reclaim',
      claimToken: 'claim-token-failure-count-reclaim',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
    });
    expect(reclaimed).toMatchObject({
      id: 'admission-failure-count',
      retryCount: 2,
      failureCount: 1,
    });

    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-failure-count',
        claimToken: 'claim-token-failure-count-reclaim',
        workerInstanceId: 'worker-failure-count-reclaim',
        state: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('claims only work items for the requested app scope', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-other-app',
      ...base,
      appId: 'app-other',
      messageId: 'message:tg:live-admission:other-app',
      messageCursor: '2026-06-16T00:00:02.000Z::other-app',
      idempotencyKey: 'telegram:delivery:other-app',
      now: toIso(nowMs() - 7_000),
    });

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-app-scope',
      claimToken: 'claim-token-app-scope',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });

    expect(claimed.map((item) => item.id)).not.toContain('admission-other-app');
  });

  it('renews a claim before another worker can reclaim an expired batch row', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-renew-expiry',
      ...base,
      messageId: 'message:tg:live-admission:renew-expiry',
      messageCursor: '2026-06-16T00:00:02.500Z::renew-expiry',
      idempotencyKey: 'telegram:delivery:renew-expiry',
      now: toIso(nowMs() - 6_000),
    });
    const first = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-renew-a',
      claimToken: 'claim-token-renew-a',
      claimExpiresAt: '2026-06-16T00:00:03.000Z',
      limit: 1,
      now: '2026-06-16T00:00:02.000Z',
    });
    expect(first.map((item) => item.id)).toEqual(['admission-renew-expiry']);

    await expect(
      liveTurns.renewLiveAdmissionWorkItemClaim({
        id: 'admission-renew-expiry',
        workerInstanceId: 'worker-renew-a',
        claimToken: 'claim-token-renew-a',
        claimExpiresAt: '2026-06-16T00:01:00.000Z',
        now: '2026-06-16T00:00:02.500Z',
      }),
    ).resolves.toBe(true);
    await expect(
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-renew-b',
        claimToken: 'claim-token-renew-b',
        claimExpiresAt: '2026-06-16T00:02:00.000Z',
        limit: 1,
        now: '2026-06-16T00:00:04.000Z',
      }),
    ).resolves.toEqual([]);

    await liveTurns.settleLiveAdmissionWorkItem({
      id: 'admission-renew-expiry',
      workerInstanceId: 'worker-renew-a',
      claimToken: 'claim-token-renew-a',
      state: 'completed',
    });
  });

  it('rejects stale settlement and accepts the active claim fence', async () => {
    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-1',
        claimToken: 'claim-token-1',
        workerInstanceId: 'worker-1',
        state: 'completed',
      }),
    ).resolves.toBe(false);

    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-1',
        claimToken: 'claim-token-2',
        workerInstanceId: 'worker-2',
        state: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('claims concurrent due rows without duplicate ownership', async () => {
    const createdAt = toIso(nowMs() - 8_000);
    for (const suffix of ['a', 'b']) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id: `admission-concurrent-${suffix}`,
        ...base,
        messageId: `message:tg:live-admission:concurrent-${suffix}`,
        messageCursor: `2026-06-16T00:00:03.000Z::concurrent-${suffix}`,
        idempotencyKey: `telegram:delivery:concurrent-${suffix}`,
        now: createdAt,
      });
    }

    const [workerA, workerB] = await Promise.all([
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-concurrent-a',
        claimToken: 'claim-token-concurrent-a',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 2,
      }),
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-concurrent-b',
        claimToken: 'claim-token-concurrent-b',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 2,
      }),
    ]);

    const claimed = [...workerA, ...workerB];
    expect(claimed.map((item) => item.id).sort()).toEqual([
      'admission-concurrent-a',
      'admission-concurrent-b',
    ]);
    expect(new Set(claimed.map((item) => item.id)).size).toBe(2);
    for (const item of claimed) {
      await expect(
        liveTurns.settleLiveAdmissionWorkItem({
          id: item.id,
          claimToken: item.claimToken ?? '',
          workerInstanceId: item.claimWorkerInstanceId ?? '',
          state: 'completed',
        }),
      ).resolves.toBe(true);
    }
  });

  it('does not let branch preselection locks hide older concurrent candidates', async () => {
    const createdAt = '2026-06-16T00:00:10.000Z';
    const dueAt = '2000-01-01T00:00:00.000Z';
    const now = '2026-06-16T00:01:00.000Z';
    const ids = [
      'admission-lock-queued',
      'admission-lock-due-1',
      'admission-lock-due-2',
    ];
    for (const [index, id] of ids.entries()) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id,
        ...base,
        messageId: `message:tg:live-admission:${id}`,
        messageCursor: `2026-06-16T00:00:10.000Z::${id}`,
        idempotencyKey: `telegram:delivery:${id}`,
        now: toIso(Date.parse(createdAt) + index),
      });
    }
    await runtime.service.pool.query(
      `UPDATE ${quotePostgresIdentifier(
        runtime.schemaName,
      )}.${quotePostgresIdentifier('live_admission_work_items')}
       SET state = 'deferred',
           defer_until = $1,
           deferred_reason = 'retry',
           updated_at = $2
       WHERE id IN ($3, $4)`,
      [dueAt, now, 'admission-lock-due-1', 'admission-lock-due-2'],
    );

    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    const held = await runtime.service.pool.connect();
    try {
      await held.query('BEGIN');
      const first = await held.query<{ id: string }>(
        `WITH queued AS (
           SELECT id, created_at
           FROM ${tableName}
           WHERE state = 'queued'
           ORDER BY created_at ASC, id ASC
           LIMIT $2
         ),
         due_deferred AS (
           SELECT id, created_at
           FROM ${tableName}
           WHERE state = 'deferred'
             AND defer_until <= $1
           ORDER BY defer_until ASC, created_at ASC, id ASC
           LIMIT $2
         ),
         candidates AS (
           SELECT id, created_at FROM queued
           UNION ALL
           SELECT id, created_at FROM due_deferred
         )
         SELECT id
         FROM ${tableName}
         INNER JOIN candidates USING (id)
         WHERE state = 'queued'
           OR (
             state = 'deferred'
             AND defer_until <= $1
           )
         ORDER BY candidates.created_at ASC, candidates.id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, 1],
      );
      expect(first.rows.map((row) => row.id)).toEqual([
        'admission-lock-queued',
      ]);

      const second = await liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-lock-probe',
        claimToken: 'claim-token-lock-probe',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 1,
        now,
      });
      expect(second.map((item) => item.id)).toEqual(['admission-lock-due-1']);
    } finally {
      await held.query('ROLLBACK').catch(() => undefined);
      held.release();
      await runtime.service.pool.query(
        `UPDATE ${tableName}
         SET state = 'completed',
             ended_at = $1,
             updated_at = $1
         WHERE id = ANY($2::text[])`,
        [now, ids],
      );
    }
  });

  it('keeps original message order for deferred retries inside the candidate window', async () => {
    const ids = [
      'admission-due-old-later-ready',
      'admission-due-newer-earlier-ready',
    ];
    for (const [index, id] of ids.entries()) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id,
        ...base,
        messageId: `message:tg:live-admission:${id}`,
        messageCursor: `2026-06-16T00:00:20.000Z::${id}`,
        idempotencyKey: `telegram:delivery:${id}`,
        now: toIso(Date.parse('2026-06-16T00:00:20.000Z') + index),
      });
    }
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'deferred',
           defer_until = CASE
             WHEN id = $1 THEN '2000-01-02T00:00:00.000Z'::timestamptz
             ELSE '2000-01-01T00:00:00.000Z'::timestamptz
           END,
           deferred_reason = 'retry',
           updated_at = '2026-06-16T00:00:30.000Z'::timestamptz
       WHERE id = ANY($2::text[])`,
      [ids[0], ids],
    );

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-due-order',
      claimToken: 'claim-token-due-order',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
      now: '2001-01-01T00:00:00.000Z',
    });
    expect(claimed.map((item) => item.id)).toEqual([
      'admission-due-old-later-ready',
    ]);

    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'completed',
           ended_at = '2026-06-16T00:00:31.000Z'::timestamptz,
           updated_at = '2026-06-16T00:00:31.000Z'::timestamptz
       WHERE id = ANY($1::text[])`,
      [ids],
    );
  });

  it('keeps original message order for expired claims inside the candidate window', async () => {
    const ids = [
      'admission-expired-old-later-expiry',
      'admission-expired-newer-earlier-expiry',
    ];
    for (const [index, id] of ids.entries()) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id,
        ...base,
        messageId: `message:tg:live-admission:${id}`,
        messageCursor: `2026-06-16T00:00:40.000Z::${id}`,
        idempotencyKey: `telegram:delivery:${id}`,
        now: toIso(Date.parse('2026-06-16T00:00:40.000Z') + index),
      });
    }
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'claimed',
           claim_worker_instance_id = 'stale-worker',
           claim_token = 'stale-token',
           claim_expires_at = CASE
             WHEN id = $1 THEN '2000-01-02T00:00:00.000Z'::timestamptz
             ELSE '2000-01-01T00:00:00.000Z'::timestamptz
           END,
           claimed_at = '2026-06-16T00:00:41.000Z'::timestamptz,
           updated_at = '2026-06-16T00:00:41.000Z'::timestamptz
       WHERE id = ANY($2::text[])`,
      [ids[0], ids],
    );

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-expired-order',
      claimToken: 'claim-token-expired-order',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
      now: '2001-01-01T00:00:00.000Z',
    });
    expect(claimed.map((item) => item.id)).toEqual([
      'admission-expired-old-later-expiry',
    ]);

    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'completed',
           ended_at = '2026-06-16T00:00:42.000Z'::timestamptz,
           updated_at = '2026-06-16T00:00:42.000Z'::timestamptz
       WHERE id = ANY($1::text[])`,
      [ids],
    );
  });

  it('stores an inbound message and live admission work item in one repository call', async () => {
    const message = {
      id: 'msg-atomic-1',
      chat_jid: 'tg:live-admission-atomic',
      provider: 'telegram',
      sender: 'user-atomic',
      sender_name: 'Atomic User',
      content: 'sensitive prompt body',
      timestamp: '2026-06-16T00:00:02.000Z',
      is_from_me: false,
      is_bot_message: false,
    };

    const result = await runtime.ops.storeMessageWithLiveAdmission?.(message, {
      appId: 'default',
      agentId: 'atomic_agent',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
    });

    expect(result?.outcome).toBe('enqueued');
    expect(result?.item).toMatchObject({
      appId: 'default',
      agentId: 'agent:atomic_agent',
      conversationId: 'tg:live-admission-atomic',
      threadId: null,
      queueJid: expect.stringContaining('tg:live-admission-atomic'),
      messageId: expect.stringMatching(/^message:/),
      senderUserId: 'user-atomic',
      senderDisplayName: 'Atomic User',
      state: 'queued',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
    });
    expect(JSON.stringify(result?.item)).not.toContain('sensitive prompt body');

    await expect(
      runtime.ops.getMessagesSince('tg:live-admission-atomic', '', 10, {
        threadId: null,
      }),
    ).resolves.toMatchObject([
      {
        id: 'msg-atomic-1',
        content: 'sensitive prompt body',
      },
    ]);

    const replay = await runtime.ops.storeMessageWithLiveAdmission?.(message, {
      appId: 'default',
      agentId: 'atomic_agent',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
    });
    expect(replay?.outcome).toBe('replayed');
    expect(replay?.item.id).toBe(result?.item.id);

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-no-notify',
      claimToken: 'claim-token-no-notify',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });
    expect(claimed.map((item) => item.id)).toContain(result?.item.id);
  });

  it('stores accepted runtime event and live admission atomically', async () => {
    const message = {
      id: 'msg-event-admission-1',
      chat_jid: 'tg:live-admission-event-atomic',
      provider: 'telegram',
      sender: 'user-event-admission',
      sender_name: 'Event Admission User',
      content: 'accepted event and admission body',
      timestamp: '2026-06-16T00:00:03.000Z',
      is_from_me: false,
      is_bot_message: false,
    };

    const result =
      await runtime.storageRuntime.runtimeEvents.publishWithLiveAdmissionMessage(
        {
          appId: 'default' as never,
          eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
          actor: 'sdk',
          payload: {
            messageId: message.id,
            text: message.content,
          },
          createdAt: message.timestamp,
        },
        {
          message,
          liveAdmission: {
            appId: 'default',
            agentId: 'event_admission_agent',
            triggerDecision: {
              source: 'sdk_session',
            },
            now: message.timestamp,
          },
        },
      );

    expect(result.event).toMatchObject({
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
      payload: {
        messageId: message.id,
        text: message.content,
      },
    });
    expect(result.liveAdmissionResult?.item).toMatchObject({
      state: 'queued',
      messageId: expect.stringMatching(/^message:/),
    });
    await expect(
      runtime.ops.getMessagesSince('tg:live-admission-event-atomic', '', 10, {
        threadId: null,
      }),
    ).resolves.toMatchObject([
      {
        id: 'msg-event-admission-1',
        content: 'accepted event and admission body',
      },
    ]);

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-event-admission',
      claimToken: 'claim-token-event-admission',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });
    expect(claimed.map((item) => item.id)).toContain(
      result.liveAdmissionResult?.item.id,
    );
  });
});
