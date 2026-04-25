import * as pgSchema from './schema.js';

export type ControlResponseMode = 'sse' | 'webhook' | 'both' | 'none';

export interface AppSessionRecord {
  sessionId: string;
  appId: string;
  conversationId: string;
  chatJid: string;
  groupFolder: string;
  title: string | null;
  defaultResponseMode: ControlResponseMode;
  defaultWebhookId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ControlEventRecord {
  eventId: number;
  eventType: string;
  sessionId: string | null;
  jobId: string | null;
  runId: string | null;
  triggerId: string | null;
  correlationId: string | null;
  actor: string;
  payload: string;
  createdAt: string;
}

export interface WebhookRegistrationRecord {
  webhookId: string;
  appId: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryRecord {
  deliveryId: string;
  webhookId: string;
  eventId: number;
  status: string;
  attemptCount: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobTriggerRecord {
  triggerId: string;
  jobId: string;
  runId: string | null;
  requestedAt: string;
  requestedBy: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppResponseRouteRecord {
  sessionId: string;
  threadId: string;
  responseMode: ControlResponseMode;
  webhookId: string | null;
  correlationId: string | null;
  updatedAt: string;
}

export interface ClaimedWebhookDeliveryRecord extends WebhookDeliveryRecord {
  webhook:
    | (WebhookRegistrationRecord & {
        secret: string;
      })
    | null;
  event: ControlEventRecord | null;
  sessionAppId: string | null;
}

export function toSessionRecord(
  row: typeof pgSchema.appSessionsPostgres.$inferSelect,
): AppSessionRecord {
  return {
    sessionId: row.sessionId,
    appId: row.appId,
    conversationId: row.conversationId,
    chatJid: row.chatJid,
    groupFolder: row.groupFolder,
    title: row.title ?? null,
    defaultResponseMode:
      (row.defaultResponseMode as ControlResponseMode) || 'sse',
    defaultWebhookId: row.defaultWebhookId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toResponseRouteRecord(
  row: typeof pgSchema.appResponseRoutesPostgres.$inferSelect,
): AppResponseRouteRecord {
  return {
    sessionId: row.sessionId,
    threadId: row.threadId,
    responseMode: row.responseMode as ControlResponseMode,
    webhookId: row.webhookId ?? null,
    correlationId: row.correlationId ?? null,
    updatedAt: row.updatedAt,
  };
}

export function toEventRecord(
  row: typeof pgSchema.controlEventsPostgres.$inferSelect,
): ControlEventRecord {
  return {
    eventId: row.eventId,
    eventType: row.eventType,
    sessionId: row.sessionId ?? null,
    jobId: row.jobId ?? null,
    runId: row.runId ?? null,
    triggerId: row.triggerId ?? null,
    correlationId: row.correlationId ?? null,
    actor: row.actor,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

export function toWebhookRecord(
  row: typeof pgSchema.webhookRegistrationsPostgres.$inferSelect,
): WebhookRegistrationRecord {
  return {
    webhookId: row.webhookId,
    appId: row.appId,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toDeliveryRecord(
  row: typeof pgSchema.webhookDeliveriesPostgres.$inferSelect,
): WebhookDeliveryRecord {
  return {
    deliveryId: row.deliveryId,
    webhookId: row.webhookId,
    eventId: row.eventId,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    lastAttemptAt: row.lastAttemptAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toTriggerRecord(
  row: typeof pgSchema.jobTriggersPostgres.$inferSelect,
): JobTriggerRecord {
  return {
    triggerId: row.triggerId,
    jobId: row.jobId,
    runId: row.runId ?? null,
    requestedAt: row.requestedAt,
    requestedBy: row.requestedBy,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
