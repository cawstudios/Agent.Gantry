import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const PermissionEffectSchema = z.enum([
  'allow',
  'deny',
  'require_approval',
  'require_sandbox',
]);
export type PermissionEffect = z.infer<typeof PermissionEffectSchema>;

export const PermissionRuleResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  policyId: z.string(),
  priority: z.number().int(),
  effect: PermissionEffectSchema,
  match: ContractMetadataSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type PermissionRuleResponse = z.infer<
  typeof PermissionRuleResponseSchema
>;

export const PermissionPolicyResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: z.enum(['active', 'inactive', 'archived']),
  rules: z.array(PermissionRuleResponseSchema).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type PermissionPolicyResponse = z.infer<
  typeof PermissionPolicyResponseSchema
>;

export const PermissionDecisionResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  policyId: z.string().nullable().optional(),
  ruleIds: z.array(z.string()),
  runId: z.string().nullable().optional(),
  toolId: z.string().nullable().optional(),
  effect: PermissionEffectSchema,
  reason: z.string(),
  approverRef: z.string().nullable().optional(),
  expiresAt: IsoDateTimeSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type PermissionDecisionResponse = z.infer<
  typeof PermissionDecisionResponseSchema
>;
