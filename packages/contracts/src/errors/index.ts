import { z } from 'zod';

import { ContractMetadataSchema } from '../contract-primitives.js';

export const ContractErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: ContractMetadataSchema.nullable().optional(),
  retryable: z.boolean().optional(),
  requestId: z.string().optional(),
  restartRequired: z.boolean().optional(),
  nextAction: z.string().optional(),
});
export type ContractError = z.infer<typeof ContractErrorSchema>;

export const ErrorResponseSchema = z.object({
  error: ContractErrorSchema,
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
