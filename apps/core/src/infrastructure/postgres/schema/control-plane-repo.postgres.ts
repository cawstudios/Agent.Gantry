import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { nowIso as currentIso } from '../../time/datetime.js';
import type {
  AppResponseRouteRecord,
  AppSessionRecord,
  ClaimedWebhookDeliveryRecord,
  ControlEventRecord,
  ControlResponseMode,
  JobTriggerRecord,
  WebhookDeliveryRecord,
  WebhookRegistrationRecord,
} from './control-plane-records.postgres.js';
import {
  toDeliveryRecord,
  toEventRecord,
  toResponseRouteRecord,
  toSessionRecord,
  toTriggerRecord,
  toWebhookRecord,
} from './control-plane-records.postgres.js';
import * as pgSchema from './schema.js';

export class PostgresControlPlaneRepository {
  constructor(private readonly db: NodePgDatabase<typeof pgSchema>) {}

  async ensureAppSession(input: {
    appId: string;
    conversationId: string;
    chatJid: string;
    groupFolder: string;
    title?: string | null;
    defaultResponseMode?: ControlResponseMode;
    defaultWebhookId?: string | null;
  }): Promise<AppSessionRecord> {
    const s = pgSchema.appSessionsPostgres;
    const now = currentIso();
    const sessionId = randomUUID();
    const rows = await this.db
      .insert(s)
      .values({
        sessionId,
        appId: input.appId,
        conversationId: input.conversationId,
        chatJid: input.chatJid,
        groupFolder: input.groupFolder,
        title: input.title ?? null,
        defaultResponseMode: input.defaultResponseMode ?? 'sse',
        defaultWebhookId: input.defaultWebhookId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [s.appId, s.conversationId],
        set: {
          chatJid: input.chatJid,
          groupFolder: input.groupFolder,
          title: input.title ?? null,
          defaultResponseMode: input.defaultResponseMode ?? 'sse',
          defaultWebhookId: input.defaultWebhookId ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return toSessionRecord(rows[0]!);
  }

  async getAppSessionById(
    sessionId: string,
  ): Promise<AppSessionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.appSessionsPostgres)
      .where(eq(pgSchema.appSessionsPostgres.sessionId, sessionId))
      .limit(1);
    return rows[0] ? toSessionRecord(rows[0]) : undefined;
  }

  async getAppSessionByChatJid(
    chatJid: string,
  ): Promise<AppSessionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.appSessionsPostgres)
      .where(eq(pgSchema.appSessionsPostgres.chatJid, chatJid))
      .limit(1);
    return rows[0] ? toSessionRecord(rows[0]) : undefined;
  }

  async addControlEvent(input: {
    eventType: string;
    payload: string;
    actor?: string;
    sessionId?: string | null;
    jobId?: string | null;
    runId?: string | null;
    triggerId?: string | null;
    correlationId?: string | null;
    responseMode?: ControlResponseMode;
    webhookId?: string | null;
  }): Promise<ControlEventRecord> {
    const e = pgSchema.controlEventsPostgres;
    const now = currentIso();
    const rows = await this.db
      .insert(e)
      .values({
        eventType: input.eventType,
        payload: input.payload,
        actor: input.actor ?? 'runtime',
        sessionId: input.sessionId ?? null,
        jobId: input.jobId ?? null,
        runId: input.runId ?? null,
        triggerId: input.triggerId ?? null,
        correlationId: input.correlationId ?? null,
        createdAt: now,
      })
      .returning();
    const event = toEventRecord(rows[0]!);
    const mode = input.responseMode ?? 'sse';
    const webhookId = input.webhookId ?? null;
    if ((mode === 'webhook' || mode === 'both') && webhookId) {
      await this.enqueueWebhookDelivery(event.eventId, webhookId);
    }
    return event;
  }

  async upsertAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
    responseMode: ControlResponseMode;
    webhookId?: string | null;
    correlationId?: string | null;
  }): Promise<AppResponseRouteRecord> {
    const r = pgSchema.appResponseRoutesPostgres;
    const now = currentIso();
    const rows = await this.db
      .insert(r)
      .values({
        sessionId: input.sessionId,
        threadId: input.threadId?.trim() || '',
        responseMode: input.responseMode,
        webhookId: input.webhookId ?? null,
        correlationId: input.correlationId ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [r.sessionId, r.threadId],
        set: {
          responseMode: input.responseMode,
          webhookId: input.webhookId ?? null,
          correlationId: input.correlationId ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return toResponseRouteRecord(rows[0]!);
  }

  async getAppResponseRoute(input: {
    sessionId: string;
    threadId?: string | null;
  }): Promise<AppResponseRouteRecord | undefined> {
    const r = pgSchema.appResponseRoutesPostgres;
    const rows = await this.db
      .select()
      .from(r)
      .where(
        and(
          eq(r.sessionId, input.sessionId),
          eq(r.threadId, input.threadId?.trim() || ''),
        ),
      )
      .limit(1);
    return rows[0] ? toResponseRouteRecord(rows[0]) : undefined;
  }

  async listSessionEvents(input: {
    sessionId: string;
    afterEventId?: number;
    limit?: number;
  }): Promise<ControlEventRecord[]> {
    const e = pgSchema.controlEventsPostgres;
    const where = input.afterEventId
      ? and(eq(e.sessionId, input.sessionId), gt(e.eventId, input.afterEventId))
      : eq(e.sessionId, input.sessionId);
    const rows = await this.db
      .select()
      .from(e)
      .where(where)
      .orderBy(asc(e.eventId))
      .limit(input.limit ?? 100);
    return rows.map((row) => toEventRecord(row));
  }

  async listRecentEventsForRun(runId: string): Promise<ControlEventRecord[]> {
    const e = pgSchema.controlEventsPostgres;
    const rows = await this.db
      .select()
      .from(e)
      .where(eq(e.runId, runId))
      .orderBy(asc(e.eventId));
    return rows.map((row) => toEventRecord(row));
  }

  async registerWebhook(input: {
    webhookId?: string;
    appId: string;
    name: string;
    url: string;
    secret: string;
    enabled?: boolean;
  }): Promise<WebhookRegistrationRecord> {
    const w = pgSchema.webhookRegistrationsPostgres;
    const now = currentIso();
    const webhookId = input.webhookId ?? randomUUID();
    const rows = await this.db
      .insert(w)
      .values({
        webhookId,
        appId: input.appId,
        name: input.name,
        url: input.url,
        secret: input.secret,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: w.webhookId,
        set: {
          appId: input.appId,
          name: input.name,
          url: input.url,
          secret: input.secret,
          enabled: input.enabled ?? true,
          updatedAt: now,
        },
      })
      .returning();
    return toWebhookRecord(rows[0]!);
  }

  async getWebhookById(
    webhookId: string,
    appId?: string,
  ): Promise<(WebhookRegistrationRecord & { secret: string }) | undefined> {
    const w = pgSchema.webhookRegistrationsPostgres;
    const rows = await this.db
      .select()
      .from(w)
      .where(
        appId
          ? and(eq(w.webhookId, webhookId), eq(w.appId, appId))
          : eq(w.webhookId, webhookId),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      ...toWebhookRecord(row),
      secret: row.secret,
    };
  }

  async listWebhooks(appId?: string): Promise<WebhookRegistrationRecord[]> {
    const w = pgSchema.webhookRegistrationsPostgres;
    const rows = appId
      ? await this.db
          .select()
          .from(w)
          .where(eq(w.appId, appId))
          .orderBy(desc(w.updatedAt))
      : await this.db.select().from(w).orderBy(desc(w.updatedAt));
    return rows.map((row) => toWebhookRecord(row));
  }

  async updateWebhook(
    webhookId: string,
    appId: string,
    patch: {
      name?: string;
      url?: string;
      secret?: string;
      enabled?: boolean;
    },
  ): Promise<WebhookRegistrationRecord | undefined> {
    const w = pgSchema.webhookRegistrationsPostgres;
    const set: Partial<typeof w.$inferInsert> = {
      updatedAt: currentIso(),
    };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.secret !== undefined) set.secret = patch.secret;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const rows = await this.db
      .update(w)
      .set(set)
      .where(and(eq(w.webhookId, webhookId), eq(w.appId, appId)))
      .returning();
    return rows[0] ? toWebhookRecord(rows[0]) : undefined;
  }

  async deleteWebhook(webhookId: string, appId?: string): Promise<void> {
    const w = pgSchema.webhookRegistrationsPostgres;
    await this.db
      .delete(w)
      .where(
        appId
          ? and(eq(w.webhookId, webhookId), eq(w.appId, appId))
          : eq(w.webhookId, webhookId),
      );
  }

  async enqueueWebhookDelivery(
    eventId: number,
    webhookId: string,
  ): Promise<WebhookDeliveryRecord> {
    const d = pgSchema.webhookDeliveriesPostgres;
    const now = currentIso();
    const rows = await this.db
      .insert(d)
      .values({
        deliveryId: randomUUID(),
        webhookId,
        eventId,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return toDeliveryRecord(rows[0]);

    const existing = await this.db
      .select()
      .from(d)
      .where(and(eq(d.webhookId, webhookId), eq(d.eventId, eventId)))
      .limit(1);
    return toDeliveryRecord(existing[0]!);
  }

  async listDueWebhookDeliveries(limit = 50): Promise<WebhookDeliveryRecord[]> {
    const d = pgSchema.webhookDeliveriesPostgres;
    const rows = await this.db
      .select()
      .from(d)
      .where(
        and(
          inArray(d.status, ['pending', 'retrying', 'delivering']),
          lte(d.nextAttemptAt, currentIso()),
        ),
      )
      .orderBy(asc(d.nextAttemptAt), asc(d.createdAt))
      .limit(limit);
    return rows.map((row) => toDeliveryRecord(row));
  }

  async claimDueWebhookDeliveries(
    limit = 50,
  ): Promise<ClaimedWebhookDeliveryRecord[]> {
    const d = pgSchema.webhookDeliveriesPostgres;
    const now = currentIso();
    const leaseUntil = new Date(Date.now() + 15_000).toISOString();
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(d)
        .where(
          and(
            inArray(d.status, ['pending', 'retrying', 'delivering']),
            lte(d.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(d.nextAttemptAt), asc(d.createdAt))
        .limit(limit);

      const claimed: WebhookDeliveryRecord[] = [];
      for (const candidate of candidates) {
        const rows = await tx
          .update(d)
          .set({
            status: 'delivering',
            attemptCount: candidate.attemptCount + 1,
            nextAttemptAt: leaseUntil,
            lastAttemptAt: now,
            updatedAt: now,
            lastError: null,
          })
          .where(
            and(
              eq(d.deliveryId, candidate.deliveryId),
              inArray(d.status, ['pending', 'retrying', 'delivering']),
              lte(d.nextAttemptAt, now),
            ),
          )
          .returning();
        if (rows[0]) claimed.push(toDeliveryRecord(rows[0]));
      }
      if (claimed.length === 0) return [];

      const webhookIds = [...new Set(claimed.map((row) => row.webhookId))];
      const eventIds = [...new Set(claimed.map((row) => row.eventId))];
      const webhookRows = await tx
        .select()
        .from(pgSchema.webhookRegistrationsPostgres)
        .where(
          inArray(pgSchema.webhookRegistrationsPostgres.webhookId, webhookIds),
        );
      const eventRows = await tx
        .select()
        .from(pgSchema.controlEventsPostgres)
        .where(inArray(pgSchema.controlEventsPostgres.eventId, eventIds));
      const sessionIds = [
        ...new Set(
          eventRows
            .map((row) => row.sessionId)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      const sessionRows =
        sessionIds.length > 0
          ? await tx
              .select()
              .from(pgSchema.appSessionsPostgres)
              .where(
                inArray(pgSchema.appSessionsPostgres.sessionId, sessionIds),
              )
          : [];
      const webhooks = new Map(
        webhookRows.map((row) => [
          row.webhookId,
          { ...toWebhookRecord(row), secret: row.secret },
        ]),
      );
      const events = new Map(
        eventRows.map((row) => [row.eventId, toEventRecord(row)]),
      );
      const sessionApps = new Map(
        sessionRows.map((row) => [row.sessionId, row.appId]),
      );
      return claimed.map((delivery) => {
        const event = events.get(delivery.eventId) ?? null;
        return {
          ...delivery,
          webhook: webhooks.get(delivery.webhookId) ?? null,
          event,
          sessionAppId: event?.sessionId
            ? (sessionApps.get(event.sessionId) ?? null)
            : null,
        };
      });
    });
  }

  async markWebhookDeliveryDelivered(deliveryId: string): Promise<void> {
    const d = pgSchema.webhookDeliveriesPostgres;
    const now = currentIso();
    await this.db
      .update(d)
      .set({
        status: 'delivered',
        deliveredAt: now,
        lastAttemptAt: now,
        updatedAt: now,
        lastError: null,
      })
      .where(eq(d.deliveryId, deliveryId));
  }

  async markWebhookDeliveryDelivering(input: {
    deliveryId: string;
    attemptCount: number;
    nextAttemptAt: string;
  }): Promise<void> {
    const d = pgSchema.webhookDeliveriesPostgres;
    const now = currentIso();
    await this.db
      .update(d)
      .set({
        status: 'delivering',
        attemptCount: input.attemptCount,
        nextAttemptAt: input.nextAttemptAt,
        lastAttemptAt: now,
        updatedAt: now,
        lastError: null,
      })
      .where(eq(d.deliveryId, input.deliveryId));
  }

  async markWebhookDeliveryRetry(input: {
    deliveryId: string;
    nextAttemptAt: string;
    lastError: string;
  }): Promise<void> {
    const d = pgSchema.webhookDeliveriesPostgres;
    await this.db
      .update(d)
      .set({
        status: 'retrying',
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: currentIso(),
        lastError: input.lastError,
      })
      .where(eq(d.deliveryId, input.deliveryId));
  }

  async markWebhookDeliveryDead(
    deliveryId: string,
    lastError: string,
  ): Promise<void> {
    const d = pgSchema.webhookDeliveriesPostgres;
    await this.db
      .update(d)
      .set({
        status: 'dead_lettered',
        lastAttemptAt: currentIso(),
        updatedAt: currentIso(),
        lastError,
      })
      .where(eq(d.deliveryId, deliveryId));
  }

  async replayWebhookDeadLetters(
    webhookId: string,
    appId: string,
  ): Promise<number> {
    const webhook = await this.getWebhookById(webhookId, appId);
    if (!webhook) return 0;
    const d = pgSchema.webhookDeliveriesPostgres;
    const rows = await this.db
      .update(d)
      .set({
        status: 'pending',
        nextAttemptAt: currentIso(),
        updatedAt: currentIso(),
      })
      .where(and(eq(d.webhookId, webhookId), eq(d.status, 'dead_lettered')))
      .returning({ deliveryId: d.deliveryId });
    return rows.length;
  }

  async purgeWebhookDeadLetters(
    webhookId: string,
    appId: string,
  ): Promise<number> {
    const webhook = await this.getWebhookById(webhookId, appId);
    if (!webhook) return 0;
    const d = pgSchema.webhookDeliveriesPostgres;
    const rows = await this.db
      .delete(d)
      .where(and(eq(d.webhookId, webhookId), eq(d.status, 'dead_lettered')))
      .returning({ deliveryId: d.deliveryId });
    return rows.length;
  }

  async createJobTrigger(input: {
    jobId: string;
    requestedBy?: string;
  }): Promise<JobTriggerRecord> {
    const t = pgSchema.jobTriggersPostgres;
    const now = currentIso();
    const rows = await this.db
      .insert(t)
      .values({
        triggerId: randomUUID(),
        jobId: input.jobId,
        runId: null,
        requestedAt: now,
        requestedBy: input.requestedBy ?? 'sdk',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toTriggerRecord(rows[0]!);
  }

  async bindPendingTriggerToRun(
    jobId: string,
    runId: string,
  ): Promise<JobTriggerRecord | undefined> {
    const t = pgSchema.jobTriggersPostgres;
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(t)
        .where(and(eq(t.jobId, jobId), eq(t.status, 'pending')))
        .orderBy(asc(t.requestedAt))
        .limit(1);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      const rows = await tx
        .update(t)
        .set({
          runId,
          status: 'claimed',
          updatedAt: currentIso(),
        })
        .where(eq(t.triggerId, candidate.triggerId))
        .returning();
      return rows[0] ? toTriggerRecord(rows[0]) : undefined;
    });
  }

  async bindTriggerToRun(
    triggerId: string,
    runId: string,
  ): Promise<JobTriggerRecord | undefined> {
    const t = pgSchema.jobTriggersPostgres;
    const rows = await this.db
      .update(t)
      .set({
        runId,
        status: 'claimed',
        updatedAt: currentIso(),
      })
      .where(and(eq(t.triggerId, triggerId), eq(t.status, 'pending')))
      .returning();
    return rows[0] ? toTriggerRecord(rows[0]) : undefined;
  }

  async markTriggerCompleted(
    triggerId: string,
    status: 'completed' | 'failed',
  ): Promise<void> {
    await this.db
      .update(pgSchema.jobTriggersPostgres)
      .set({
        status,
        updatedAt: currentIso(),
      })
      .where(eq(pgSchema.jobTriggersPostgres.triggerId, triggerId));
  }

  async getTriggerById(
    triggerId: string,
  ): Promise<JobTriggerRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.jobTriggersPostgres)
      .where(eq(pgSchema.jobTriggersPostgres.triggerId, triggerId))
      .limit(1);
    return rows[0] ? toTriggerRecord(rows[0]) : undefined;
  }

  async getEventById(eventId: number): Promise<ControlEventRecord | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.controlEventsPostgres)
      .where(eq(pgSchema.controlEventsPostgres.eventId, eventId))
      .limit(1);
    return rows[0] ? toEventRecord(rows[0]) : undefined;
  }
}
