import { z } from 'zod';

import {
  ContractMetadataSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const SandboxAccessSchema = z.enum([
  'disabled',
  'deny',
  'read_only',
  'scoped',
  'unrestricted',
  'approval_required',
]);
export type SandboxAccess = z.infer<typeof SandboxAccessSchema>;

export const SandboxProfileResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  filesystem: SandboxAccessSchema,
  network: SandboxAccessSchema,
  process: SandboxAccessSchema,
  browser: SandboxAccessSchema,
  credentialAccess: SandboxAccessSchema,
  timeoutMs: z.number().int().positive(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type SandboxProfileResponse = z.infer<
  typeof SandboxProfileResponseSchema
>;
