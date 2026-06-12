import type {
  GantryPgRuntimeStorageConfig,
  GantryRuntimeStorage,
  GantryTeamsStoredConversationReference,
} from './types.js';
import { readString } from '../../shared/helpers.js';

export function createPgGantryRuntimeStorage(
  config: GantryPgRuntimeStorageConfig,
): GantryRuntimeStorage {
  const schema = normalizeSqlIdentifier(config.schema ?? 'gantry_runtime');
  return {
    recordMessage: async (input) => {
      await config.pool.query(
        `insert into "${schema}"."runtime_messages" (provider, conversation_id, message_id, sender_id, text, payload_json, occurred_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
         on conflict (provider, message_id) do nothing`,
        [
          input.provider,
          input.conversationId,
          input.messageId,
          input.senderId ?? null,
          input.text ?? null,
          JSON.stringify(input.payload ?? {}),
          input.occurredAt,
        ],
      );
    },
    recordStructuredTaskRun: async (input) => {
      await config.pool.query(
        `insert into "${schema}"."structured_task_runs" (task_run_id, task_type, correlation_id, status, input_json, output_json, validation_report_json, error, occurred_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
         on conflict (task_run_id) do nothing`,
        [
          input.taskRunId,
          input.taskType,
          input.correlationId ?? null,
          input.status,
          JSON.stringify(input.input),
          JSON.stringify(input.output ?? {}),
          JSON.stringify(input.validationReport ?? {}),
          input.error ?? null,
          input.occurredAt,
        ],
      );
    },
    getTeamsConversationReference: async (conversationId) => {
      const normalized = normalizeTeamsJid(conversationId);
      const result = await config.pool.query(
        `select conversation_jid, conversation_id, service_url, tenant_id, bot_id, teams_user_id, raw_reference_json, updated_at
         from "${schema}"."teams_conversation_references"
         where conversation_jid = $1 or conversation_id = $2
         limit 1`,
        [normalized, conversationId],
      );
      return mapTeamsReferenceRow(result.rows[0], conversationId);
    },
    getTeamsPersonalConversationReference: async (input) => {
      const result = await config.pool.query(
        `select conversation_jid, conversation_id, service_url, tenant_id, bot_id, teams_user_id, raw_reference_json, updated_at
         from "${schema}"."teams_conversation_references"
         where teams_user_id = $1 and ($2::text is null or tenant_id = $2)
         order by updated_at desc
         limit 1`,
        [input.teamsUserId, input.teamsTenantId ?? null],
      );
      return mapTeamsReferenceRow(result.rows[0], input.teamsUserId);
    },
    saveTeamsConversationReference: async (reference) => {
      await config.pool.query(
        `insert into "${schema}"."teams_conversation_references" (conversation_jid, conversation_id, service_url, tenant_id, bot_id, teams_user_id, raw_reference_json, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
         on conflict (conversation_jid) do update set
           conversation_id = excluded.conversation_id,
           service_url = excluded.service_url,
           tenant_id = excluded.tenant_id,
           bot_id = excluded.bot_id,
           teams_user_id = excluded.teams_user_id,
           raw_reference_json = excluded.raw_reference_json,
           updated_at = excluded.updated_at`,
        [
          reference.conversationJid ??
            normalizeTeamsJid(reference.conversationId),
          reference.conversationId,
          reference.serviceUrl ?? null,
          reference.tenantId ?? null,
          reference.botId ?? null,
          reference.teamsUserId ?? null,
          reference.rawReferenceJson ?? null,
          reference.updatedAt ?? null,
        ],
      );
    },
  };
}

function normalizeTeamsJid(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('teams:') ? trimmed : `teams:${trimmed}`;
}

function normalizeSqlIdentifier(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return normalized;
}

function mapTeamsReferenceRow(
  row: Record<string, unknown> | undefined,
  fallbackConversationId: string,
): GantryTeamsStoredConversationReference | null {
  if (!row) return null;
  return {
    exists: true,
    conversationId: String(row.conversation_id ?? fallbackConversationId),
    conversationJid:
      typeof row.conversation_jid === 'string' ? row.conversation_jid : null,
    serviceUrl: typeof row.service_url === 'string' ? row.service_url : null,
    tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : null,
    botId: typeof row.bot_id === 'string' ? row.bot_id : null,
    teamsUserId:
      typeof row.teams_user_id === 'string' ? row.teams_user_id : null,
    rawReferenceJson:
      typeof row.raw_reference_json === 'string'
        ? row.raw_reference_json
        : null,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : typeof row.updated_at === 'string'
          ? row.updated_at
          : null,
  };
}
