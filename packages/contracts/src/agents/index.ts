import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
  LlmProfileRefSchema,
  RuntimeLimitSchema,
} from '../contract-primitives.js';

export const AgentStatusSchema = z.enum([
  'active',
  'inactive',
  'archived',
  'disabled',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const CreateAgentRequestSchema = z.object({
  appId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  promptProfileRef: z.string().optional(),
  llmProfileId: z.string().optional(),
  toolIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
  sandboxProfileId: z.string().optional(),
  workspaceSnapshotId: z.string().optional(),
  runtimeLimits: RuntimeLimitSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: AgentStatusSchema.optional(),
  promptProfileRef: z.string().optional(),
  llmProfileId: z.string().optional(),
  toolIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  permissionPolicyIds: z.array(z.string()).optional(),
  sandboxProfileId: z.string().nullable().optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  runtimeLimits: RuntimeLimitSchema.optional(),
  metadata: ContractMetadataSchema.optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const AgentResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: AgentStatusSchema,
  currentConfigVersionId: z.string().nullable().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export const AgentConfigVersionResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string(),
  version: z.number().int().positive(),
  promptProfileRef: z.string(),
  llmProfile: LlmProfileRefSchema.optional(),
  llmProfileId: z.string().optional(),
  toolIds: z.array(z.string()),
  skillIds: z.array(z.string()),
  permissionPolicyIds: z.array(z.string()),
  sandboxProfileId: z.string().nullable().optional(),
  workspaceSnapshotId: z.string().nullable().optional(),
  runtimeLimits: RuntimeLimitSchema.optional(),
  createdAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type AgentConfigVersionResponse = z.infer<
  typeof AgentConfigVersionResponseSchema
>;
