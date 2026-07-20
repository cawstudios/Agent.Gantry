import type { JsonSchema } from './openapi-route-helpers.js';

const isoDateTime = { type: 'string', format: 'date-time' };
const metadata = { type: 'object', additionalProperties: true };

function arrayEnvelope(name: string, itemRef: string): JsonSchema {
  return {
    type: 'object',
    required: [name],
    properties: {
      [name]: {
        type: 'array',
        items: { $ref: `#/components/schemas/${itemRef}` },
      },
    },
  };
}

export const sessionRuntimeSchemas: Record<string, JsonSchema> = {
  SessionEnsureRequest: {
    type: 'object',
    required: ['conversationId'],
    properties: {
      appId: { type: 'string', description: 'Optional API key app assertion.' },
      agentId: { type: 'string', description: 'Optional app-owned agent id.' },
      agentName: {
        type: 'string',
        description: 'Optional exact app-owned agent name.',
      },
      conversationId: { type: 'string' },
      title: { type: 'string' },
      responseMode: {
        type: 'string',
        enum: ['sse', 'webhook', 'both', 'none'],
      },
      webhookId: { type: 'string' },
    },
  },
  SessionEnsureResponse: {
    type: 'object',
    required: [
      'sessionId',
      'appId',
      'conversationId',
      'chatJid',
      'executionContext',
    ],
    properties: {
      sessionId: { type: 'string' },
      appId: { type: 'string' },
      conversationId: { type: 'string' },
      chatJid: { type: 'string' },
      executionContext: {
        type: 'object',
        required: ['conversationJid', 'threadId', 'workspaceKey', 'sessionId'],
        additionalProperties: false,
        properties: {
          conversationJid: { type: 'string' },
          threadId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          workspaceKey: { type: 'string' },
          sessionId: { type: 'string' },
        },
      },
    },
  },
  SendSessionMessageRequest: {
    type: 'object',
    required: ['message', 'idempotencyKey'],
    properties: {
      message: { type: 'string' },
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
      queuePolicy: {
        type: 'object',
        required: [
          'maxWaitingMessages',
          'maxQueueWaitMs',
          'executionTimeoutMs',
        ],
        additionalProperties: false,
        properties: {
          maxWaitingMessages: { type: 'integer', minimum: 0, maximum: 100 },
          maxQueueWaitMs: {
            type: 'integer',
            minimum: 1_000,
            maximum: 86_400_000,
          },
          executionTimeoutMs: {
            type: 'integer',
            minimum: 1_000,
            maximum: 86_400_000,
          },
        },
      },
      continuityMode: {
        type: 'string',
        enum: ['provider', 'bounded'],
        default: 'provider',
        description:
          'Provider resumes the model session; bounded reconstructs continuity from a rolling summary and recent messages.',
      },
      senderId: { type: 'string', default: 'sdk' },
      senderName: { type: 'string', default: 'SDK' },
      threadId: { type: 'string' },
      correlationId: { type: 'string' },
      responseMode: {
        type: 'string',
        enum: ['sse', 'webhook', 'both', 'none'],
      },
      webhookId: { type: 'string' },
      response_schema: {
        type: 'object',
        description:
          'JSON Schema object requesting strict structured output for this turn when supported by the selected agent engine.',
      },
      model_alias: {
        type: 'string',
        minLength: 1,
        description:
          'Explicit model alias supplied by the caller for this turn.',
      },
      effort: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      thinking: {
        oneOf: [
          { type: 'string', enum: ['off', 'on'] },
          {
            type: 'object',
            required: ['mode'],
            additionalProperties: false,
            properties: { mode: { type: 'string', enum: ['off'] } },
          },
          {
            type: 'object',
            required: ['mode'],
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: ['on'] },
              budget_tokens: { type: 'integer', minimum: 1 },
            },
          },
        ],
      },
      max_output_tokens: { type: 'integer', minimum: 1 },
      caller_resolved_tools: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        description:
          'Domain-neutral native tools whose results are resolved by the SDK caller.',
        items: {
          type: 'object',
          required: ['name', 'description', 'input_schema'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$' },
            description: { type: 'string', minLength: 1 },
            input_schema: { type: 'object' },
          },
        },
      },
      max_tool_interactions: {
        type: 'integer',
        minimum: 1,
        maximum: 4,
        default: 4,
      },
      interaction_timeout_ms: {
        type: 'integer',
        minimum: 1000,
        maximum: 90000,
        default: 90000,
      },
    },
  },
  SendSessionMessageResponse: {
    type: 'object',
    required: ['accepted', 'replayed', 'messageId', 'acceptedEventId'],
    properties: {
      accepted: { type: 'boolean' },
      replayed: { type: 'boolean' },
      messageId: { type: 'string' },
      acceptedEventId: { type: 'integer' },
    },
  },
  ResolveSessionInteractionRequest: {
    type: 'object',
    required: ['idempotencyKey', 'result'],
    additionalProperties: false,
    properties: {
      idempotencyKey: { type: 'string', minLength: 1 },
      result: metadata,
      resolvedBy: { type: 'string' },
    },
  },
  RejectSessionInteractionRequest: {
    type: 'object',
    required: ['idempotencyKey'],
    additionalProperties: false,
    properties: {
      idempotencyKey: { type: 'string', minLength: 1 },
      reason: { type: 'string' },
      resolvedBy: { type: 'string' },
    },
  },
  SessionInteractionSettlementResponse: {
    type: 'object',
    required: ['accepted', 'idempotent'],
    properties: {
      accepted: { type: 'boolean' },
      idempotent: { type: 'boolean' },
    },
  },
  CancelSessionTurnRequest: {
    type: 'object',
    additionalProperties: false,
    properties: { threadId: { type: 'string' } },
  },
  CancelSessionTurnResponse: {
    type: 'object',
    required: ['cancelled'],
    properties: { cancelled: { type: 'boolean' } },
  },
  ArchiveSessionResponse: {
    type: 'object',
    required: ['archived', 'alreadyArchived', 'cancelled'],
    additionalProperties: false,
    properties: {
      archived: { type: 'boolean' },
      alreadyArchived: { type: 'boolean' },
      cancelled: { type: 'boolean' },
    },
  },
  RuntimeEvent: {
    type: 'object',
    required: ['eventId', 'eventType', 'createdAt'],
    properties: {
      eventId: { type: 'integer' },
      eventType: { type: 'string' },
      payload: metadata,
      createdAt: isoDateTime,
    },
  },
  RuntimeEventListResponse: arrayEnvelope('events', 'RuntimeEvent'),
  AppRuntimeEvent: {
    type: 'object',
    required: ['eventId', 'eventType', 'createdAt', 'payload'],
    additionalProperties: false,
    properties: {
      eventId: { type: 'integer' },
      eventType: { type: 'string' },
      sessionId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      jobId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      runId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      triggerId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      conversationId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      threadId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      correlationId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      createdAt: isoDateTime,
      payload: metadata,
    },
  },
  AppRuntimeEventListResponse: arrayEnvelope('events', 'AppRuntimeEvent'),
};
