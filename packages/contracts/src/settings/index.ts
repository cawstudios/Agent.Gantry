import { z } from 'zod';

export const RuntimeSettingsConfiguredAgentDmAccessSchema = z
  .object({
    provider: z.string().trim().min(1),
    userIds: z.array(z.string().trim().min(1)),
    adminUserId: z.string().trim().min(1).optional(),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentBindingSchema = z
  .object({
    jid: z.string().trim().min(1),
    provider: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    trigger: z.string().trim().min(1),
    addedAt: z.string().trim().min(1),
    requiresTrigger: z.boolean(),
    isMain: z.boolean(),
    model: z.string().optional(),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentCapabilitiesSchema = z
  .object({
    toolIds: z.array(z.string().trim().min(1)),
    skillIds: z.array(z.string().trim().min(1)),
    mcpServerIds: z.array(z.string().trim().min(1)),
  })
  .strict();

export const RuntimeSettingsConfiguredAgentSchema = z
  .object({
    name: z.string().trim().min(1),
    folder: z.string().trim().min(1),
    model: z.string().optional(),
    oneTimeJobDefaultModel: z.string().optional(),
    recurringJobDefaultModel: z.string().optional(),
    bindings: z.record(z.string(), RuntimeSettingsConfiguredAgentBindingSchema),
    dmAccess: z.array(RuntimeSettingsConfiguredAgentDmAccessSchema),
    capabilities: RuntimeSettingsConfiguredAgentCapabilitiesSchema,
  })
  .strict();

export const RuntimeSettingsPublicSchema = z
  .object({
    desiredState: z
      .object({
        authoritative: z.boolean(),
      })
      .strict(),
    agent: z
      .object({
        name: z.string(),
        defaultModel: z.string(),
        oneTimeJobDefaultModel: z.string(),
        recurringJobDefaultModel: z.string(),
      })
      .strict(),
    agents: z.record(z.string(), RuntimeSettingsConfiguredAgentSchema),
    memory: z
      .object({
        enabled: z.boolean(),
        dreaming: z
          .object({
            enabled: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type RuntimeSettingsPublic = z.infer<typeof RuntimeSettingsPublicSchema>;

export const RuntimeSettingsResponseSchema = z
  .object({
    settings: RuntimeSettingsPublicSchema,
  })
  .strict();
export type RuntimeSettingsResponse = z.infer<
  typeof RuntimeSettingsResponseSchema
>;
