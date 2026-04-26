import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';
import { ContractErrorSchema } from '../errors/index.js';
import { MessageResponseSchema } from '../messages/index.js';
import { PermissionDecisionResponseSchema } from '../permissions/index.js';
import { AgentRunEventResponseSchema } from '../runs/index.js';

const StreamEventBaseSchema = z.object({
  id: z.string().optional(),
  appId: z.string().optional(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
  createdAt: IsoDateTimeSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});

export const StreamEventSchema = z.discriminatedUnion('type', [
  StreamEventBaseSchema.extend({
    type: z.literal('heartbeat'),
  }),
  StreamEventBaseSchema.extend({
    type: z.literal('run.event'),
    event: AgentRunEventResponseSchema,
  }),
  StreamEventBaseSchema.extend({
    type: z.literal('message.delta'),
    messageId: z.string().optional(),
    delta: z.string(),
  }),
  StreamEventBaseSchema.extend({
    type: z.literal('message.completed'),
    message: MessageResponseSchema,
  }),
  StreamEventBaseSchema.extend({
    type: z.literal('progress'),
    label: z.string(),
    detail: z.string().optional(),
    done: z.boolean().optional(),
  }),
  StreamEventBaseSchema.extend({
    type: z.literal('tool.requested'),
    toolCallId: z.string(),
    toolId: z.string().optional(),
    name: z.string(),
    input: z.unknown().optional(),
  }),
  StreamEventBaseSchema.extend({
    type: z.literal('tool.completed'),
    toolCallId: z.string(),
    toolId: z.string().optional(),
    output: z.unknown().optional(),
  }),
  StreamEventBaseSchema.extend({
    type: z.literal('permission.decision'),
    decision: PermissionDecisionResponseSchema,
  }),
  StreamEventBaseSchema.extend({
    type: z.literal('error'),
    error: ContractErrorSchema,
  }),
  StreamEventBaseSchema.extend({
    type: z.literal('completed'),
    status: z.enum(['completed', 'failed', 'canceled', 'timeout']),
    resultSummary: z.string().nullable().optional(),
    errorSummary: z.string().nullable().optional(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
