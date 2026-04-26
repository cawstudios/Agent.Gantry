import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
  SchemaDescriptorSchema,
} from '../contract-primitives.js';

export const ToolRiskSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const ToolCatalogItemResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().nullable().optional(),
  inputSchema: SchemaDescriptorSchema,
  outputSchema: SchemaDescriptorSchema.optional(),
  risk: ToolRiskSchema,
  permissionPolicyId: z.string().nullable().optional(),
  sandboxProfileId: z.string().nullable().optional(),
  adapterRef: z.string().optional(),
  credentialRefs: z.array(z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type ToolCatalogItemResponse = z.infer<
  typeof ToolCatalogItemResponseSchema
>;
