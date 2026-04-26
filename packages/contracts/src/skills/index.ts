import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const SkillCatalogItemResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  version: z.string(),
  promptRefs: z.array(z.string()),
  toolIds: z.array(z.string()),
  workflowRefs: z.array(z.string()),
  setupRefs: z.array(z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type SkillCatalogItemResponse = z.infer<
  typeof SkillCatalogItemResponseSchema
>;
