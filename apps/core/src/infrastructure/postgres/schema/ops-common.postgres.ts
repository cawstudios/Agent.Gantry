import { logger } from '../../logging/logger.js';
import { isPlainObject } from '../../../shared/object.js';
import type {
  Job,
  JobEvent,
  JobExecutionMode,
  JobRun,
  NewMessage,
  RegisteredGroup,
} from '../../../domain/types.js';
import { normalizeClaudeModelSelection } from '../../../models/claude-model-registry.js';
import { isValidGroupFolder } from '../../../platform/group-folder.js';
import * as pgSchema from './schema.js';

export function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeJobExecutionMode(value: unknown): JobExecutionMode {
  return value === 'serialized' ? 'serialized' : 'parallel';
}

export function parseRegisteredGroupAgentConfig(
  rawConfig: string | null,
  context: { jid: string; folder: string },
): RegisteredGroup['agentConfig'] | undefined {
  if (!rawConfig) return undefined;
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error('container_config must be a JSON object');
    }

    const config: NonNullable<RegisteredGroup['agentConfig']> = {};
    if (typeof parsed.model === 'string' && parsed.model.trim()) {
      config.model = (
        normalizeClaudeModelSelection(parsed.model) || parsed.model.trim()
      ).slice(0, 120);
    }
    if (
      typeof parsed.timeout === 'number' &&
      Number.isFinite(parsed.timeout) &&
      parsed.timeout >= 1_000 &&
      parsed.timeout <= 3_600_000
    ) {
      config.timeout = Math.round(parsed.timeout);
    }
    if (Array.isArray(parsed.additionalMounts)) {
      const mounts = parsed.additionalMounts
        .filter((item) => isPlainObject(item))
        .map((item) => {
          const hostPath =
            typeof item.hostPath === 'string' ? item.hostPath.trim() : '';
          if (!hostPath) return null;
          const mount: {
            hostPath: string;
            containerPath?: string;
            readonly?: boolean;
          } = { hostPath };
          if (
            typeof item.containerPath === 'string' &&
            item.containerPath.trim().length > 0
          ) {
            mount.containerPath = item.containerPath.trim();
          }
          if (typeof item.readonly === 'boolean') {
            mount.readonly = item.readonly;
          }
          return mount;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      if (mounts.length > 0) config.additionalMounts = mounts;
    }

    if (isPlainObject(parsed.thinking)) {
      const mode = parsed.thinking.mode;
      if (mode === 'adaptive' || mode === 'enabled' || mode === 'disabled') {
        config.thinking = { mode };
        if (
          parsed.thinking.effort === 'low' ||
          parsed.thinking.effort === 'medium' ||
          parsed.thinking.effort === 'high' ||
          parsed.thinking.effort === 'max'
        ) {
          config.thinking.effort = parsed.thinking.effort;
        }
        if (
          typeof parsed.thinking.budgetTokens === 'number' &&
          Number.isFinite(parsed.thinking.budgetTokens) &&
          parsed.thinking.budgetTokens >= 0
        ) {
          config.thinking.budgetTokens = Math.round(
            parsed.thinking.budgetTokens,
          );
        }
        if (
          parsed.thinking.display === 'summarized' ||
          parsed.thinking.display === 'omitted'
        ) {
          config.thinking.display = parsed.thinking.display;
        }
      }
    }

    return Object.keys(config).length > 0 ? config : undefined;
  } catch (err) {
    logger.warn(
      { jid: context.jid, folder: context.folder, err },
      'Ignoring invalid registered group container_config JSON',
    );
    return undefined;
  }
}

export function mapMessageRow(
  row: typeof pgSchema.messagesPostgres.$inferSelect,
): NewMessage {
  return {
    id: row.id,
    chat_jid: row.chatJid,
    sender: row.sender || '',
    sender_name: row.senderName || '',
    content: row.content || '',
    timestamp: row.timestamp || '',
    is_from_me: row.isFromMe === true,
    thread_id: row.threadId || undefined,
    reply_to_message_id: row.replyToMessageId || null,
    reply_to_message_content: row.replyToMessageContent || null,
    reply_to_sender_name: row.replyToSenderName || null,
  } as NewMessage;
}

export function mapJobRow(row: typeof pgSchema.jobsPostgres.$inferSelect): Job {
  let linkedSessions: string[] = [];
  try {
    const parsed = JSON.parse(row.linkedSessions);
    if (Array.isArray(parsed)) {
      linkedSessions = parsed.filter((item) => typeof item === 'string');
    }
  } catch {
    linkedSessions = [];
  }

  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    script: row.script,
    schedule_type: row.scheduleType as Job['schedule_type'],
    schedule_value: row.scheduleValue,
    status: row.status as Job['status'],
    linked_sessions: linkedSessions,
    session_id: row.sessionId,
    thread_id: row.threadId,
    group_scope: row.groupScope,
    created_by: (row.createdBy as Job['created_by']) || 'agent',
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    next_run: row.nextRun,
    last_run: row.lastRun,
    silent: row.silent === true,
    cleanup_after_ms: row.cleanupAfterMs,
    timeout_ms: row.timeoutMs,
    max_retries: row.maxRetries,
    retry_backoff_ms: row.retryBackoffMs,
    max_consecutive_failures: row.maxConsecutiveFailures,
    consecutive_failures: row.consecutiveFailures,
    execution_mode: normalizeJobExecutionMode(row.executionMode),
    lease_run_id: row.leaseRunId,
    lease_expires_at: row.leaseExpiresAt,
    pause_reason: row.pauseReason,
  };
}

export function mapJobRunRow(
  row: typeof pgSchema.jobRunsPostgres.$inferSelect,
): JobRun {
  return {
    run_id: row.runId,
    job_id: row.jobId,
    scheduled_for: row.scheduledFor,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    status: row.status as JobRun['status'],
    result_summary: row.resultSummary,
    error_summary: row.errorSummary,
    retry_count: row.retryCount,
    notified_at: row.notifiedAt,
  };
}

export function mapJobEventRow(
  row: typeof pgSchema.jobEventsPostgres.$inferSelect,
): JobEvent {
  return {
    id: row.id,
    job_id: row.jobId,
    run_id: row.runId,
    event_type: row.eventType,
    payload: row.payload,
    created_at: row.createdAt,
  };
}

export function ensureValidGroupFolder(jid: string, folder: string): boolean {
  if (isValidGroupFolder(folder)) return true;
  logger.warn({ jid, folder }, 'Skipping registered group with invalid folder');
  return false;
}
