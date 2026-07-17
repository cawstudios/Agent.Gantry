import { z } from 'zod';

import type { RuntimeApiTransport } from '../../lib/api/runtime-transport';

const modelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  aliases: z.array(z.string()),
  recommendedAlias: z.string(),
  responseFamily: z.string(),
  executionRoutes: z.array(
    z.object({
      harness: z.enum(['anthropic_sdk', 'deepagents']),
      executionProviderId: z.string(),
    }),
  ),
  modelRoute: z.object({ id: z.string(), label: z.string() }),
  available: z.boolean().optional(),
  experimental: z.boolean(),
});

const modelsResponseSchema = z.object({ models: z.array(modelSchema) });

const defaultSlotSchema = z.object({
  configuredAlias: z.string().nullable(),
  effectiveAlias: z.string().nullable(),
  source: z.string(),
  inherited: z.boolean(),
});

export const modelDefaultsSchema = z.object({
  chat: defaultSlotSchema,
  jobs: z.object({ oneTime: defaultSlotSchema, recurring: defaultSlotSchema }),
  memory: z.object({
    extractor: defaultSlotSchema,
    dreaming: defaultSlotSchema,
    consolidation: defaultSlotSchema,
  }),
});

const credentialFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  secret: z.boolean(),
  required: z.boolean(),
});

const credentialModeSchema = z.object({
  id: z.string(),
  label: z.string(),
  helpText: z.string(),
  fields: z.array(credentialFieldSchema),
});

export const modelCredentialSchema = z.object({
  providerId: z.string(),
  label: z.string().optional(),
  configured: z.boolean(),
  authMode: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled']),
  health: z.enum(['ready', 'missing', 'disabled']),
  configuredFields: z.array(z.string()).optional(),
  credentialModes: z.array(credentialModeSchema),
  updatedAt: z.string().nullable().optional(),
});

const credentialsResponseSchema = z.object({
  providers: z.array(modelCredentialSchema),
});

const usageResponseSchema = z.object({
  usage: z.array(
    z.object({
      requestCount: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      model: z.string().optional(),
    }),
  ),
});

export type ModelDefaults = z.infer<typeof modelDefaultsSchema>;
export type ModelCredential = z.infer<typeof modelCredentialSchema>;

export type ModelView = {
  alias: string;
  displayName: string;
  family: string;
  compatibleHarnesses: string[];
  readiness: 'ready' | 'attention';
  requests24h: number;
  tokens24h: string;
  experimental: boolean;
};

export const modelQueryKeys = {
  all: ['models'] as const,
  catalog: () => [...modelQueryKeys.all, 'catalog'] as const,
  defaults: () => [...modelQueryKeys.all, 'defaults'] as const,
  credentials: () => [...modelQueryKeys.all, 'credentials'] as const,
  usage: () => [...modelQueryKeys.all, 'usage', '24h'] as const,
};

export async function loadModelDashboard(transport: RuntimeApiTransport) {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [catalog, defaults, credentials, usage] = await Promise.all([
    transport.request({ path: '/models', schema: modelsResponseSchema }),
    transport.request({
      path: '/models/defaults',
      schema: modelDefaultsSchema,
    }),
    transport.request({
      path: '/credentials/models',
      schema: credentialsResponseSchema,
    }),
    transport.request({
      path: '/usage',
      query: {
        from: from.toISOString(),
        to: now.toISOString(),
        group_by: 'model',
      },
      schema: usageResponseSchema,
    }),
  ]);
  return {
    models: mapModels(catalog.models, usage.usage),
    defaults,
    credentials: credentials.providers,
  };
}

export async function patchModelDefaults(
  transport: RuntimeApiTransport,
  patch: Record<string, string | null>,
) {
  return transport.request({
    path: '/models/defaults',
    method: 'PATCH',
    body: patch,
    schema: modelDefaultsSchema,
  });
}

export async function saveModelCredential(
  transport: RuntimeApiTransport,
  providerId: string,
  body: { authMode?: string; payload: Record<string, string> },
) {
  return transport.request({
    path: `/credentials/models/${encodeURIComponent(providerId)}`,
    method: 'PUT',
    body,
    schema: modelCredentialSchema,
  });
}

export async function disableModelCredential(
  transport: RuntimeApiTransport,
  providerId: string,
) {
  return transport.request({
    path: `/credentials/models/${encodeURIComponent(providerId)}`,
    method: 'DELETE',
    schema: modelCredentialSchema,
  });
}

function mapModels(
  models: z.infer<typeof modelSchema>[],
  usage: z.infer<typeof usageResponseSchema>['usage'],
): ModelView[] {
  return models.map((model) => {
    const identifiers = new Set([
      model.id,
      model.recommendedAlias,
      ...model.aliases,
    ]);
    const totals = usage
      .filter((item) => item.model && identifiers.has(item.model))
      .reduce(
        (sum, item) => ({
          requests: sum.requests + item.requestCount,
          tokens: sum.tokens + item.inputTokens + item.outputTokens,
        }),
        { requests: 0, tokens: 0 },
      );
    return {
      alias: model.recommendedAlias,
      displayName: model.displayName,
      family: model.modelRoute.label,
      compatibleHarnesses: [
        'auto',
        ...new Set(model.executionRoutes.map((route) => route.harness)),
      ],
      readiness: model.available ? 'ready' : 'attention',
      requests24h: totals.requests,
      tokens24h: formatTokenCount(totals.tokens),
      experimental: model.experimental,
    };
  });
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('en', {
    notation: value >= 1_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}
