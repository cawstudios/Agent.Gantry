import type {
  ModelExecutionProviderId,
  ModelResponseFamily,
  ModelWorkload,
} from './model-catalog.js';

export type ModelCredentialPayload = Record<string, string>;

export interface ModelCredentialFieldDefinition {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
}

export interface ModelProviderCredentialSchema {
  version: number;
  fields: readonly ModelCredentialFieldDefinition[];
}

export interface ModelGatewayAuthDefinition {
  type: 'bearer' | 'header';
  field: string;
  headerName?: string;
}

export interface ModelGatewaySdkProjectionDefinition {
  baseUrlEnv: string;
  tokenEnv: string;
  additionalTokenEnv?: string;
  credentialProviderEnvKey: string;
  credentialProvider: string;
}

export interface ModelGatewayDefinition {
  pathSegment: string;
  upstreamOrigin: string;
  upstreamPathPrefix: string;
  stripRequestHeaders: readonly string[];
  auth: ModelGatewayAuthDefinition;
  sdkProjection: ModelGatewaySdkProjectionDefinition;
}

export type ModelProviderPromptCacheMode =
  | 'none'
  | 'anthropic_cache_control'
  | 'openai_automatic_prefix'
  | 'openrouter_anthropic_cache_control';

export type ModelProviderResponseCacheMode =
  | 'none'
  | 'openrouter_response_cache';

export interface ModelProviderCacheUsageFields {
  readTokens?: string;
  writeTokens?: string;
  responseHeaders?: readonly string[];
}

export interface ModelProviderPromptCacheSupport {
  mode: ModelProviderPromptCacheMode;
  automatic: boolean;
  requestControl: 'none' | 'cache_control_blocks' | 'provider_automatic_prefix';
  ttlOptions: readonly string[];
  minimumTokenThresholds: readonly {
    modelFamily: string;
    tokens: number;
  }[];
  usageFields: ModelProviderCacheUsageFields;
}

export interface ModelProviderResponseCacheSupport {
  mode: ModelProviderResponseCacheMode;
  enabledByDefault: boolean;
  requestControl: 'none' | 'request_header';
  requestHeaders: readonly string[];
  responseHeaders: readonly string[];
  usageBehavior: 'normal_usage' | 'zero_usage_on_hit';
}

export interface ModelProviderCacheSupport {
  prompt: ModelProviderPromptCacheSupport;
  response: ModelProviderResponseCacheSupport;
}

export interface ModelProviderDefinition {
  id: string;
  label: string;
  executable: boolean;
  modelRoute: boolean;
  embeddingProvider: boolean;
  responseFamily: ModelResponseFamily;
  supportedWorkloads: readonly ModelWorkload[];
  credentialSchema: ModelProviderCredentialSchema;
  gateway: ModelGatewayDefinition;
  cacheSupport: ModelProviderCacheSupport;
  executionProviderIds: readonly ModelExecutionProviderId[];
}

const MODEL_GATEWAY_STRIP_REQUEST_HEADERS = [
  'host',
  'authorization',
  'x-api-key',
  'content-length',
  'connection',
] as const;

export const MODEL_PROVIDER_DEFINITIONS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    executable: true,
    modelRoute: true,
    embeddingProvider: false,
    responseFamily: 'anthropic',
    supportedWorkloads: [
      'chat',
      'one_time_job',
      'recurring_job',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ],
    credentialSchema: {
      version: 1,
      fields: [
        {
          name: 'apiKey',
          label: 'Anthropic API key',
          secret: true,
          required: true,
        },
      ],
    },
    gateway: {
      pathSegment: 'anthropic',
      upstreamOrigin: 'https://api.anthropic.com',
      upstreamPathPrefix: '',
      stripRequestHeaders: MODEL_GATEWAY_STRIP_REQUEST_HEADERS,
      auth: {
        type: 'header',
        field: 'apiKey',
        headerName: 'x-api-key',
      },
      sdkProjection: {
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        tokenEnv: 'ANTHROPIC_API_KEY',
        credentialProviderEnvKey: 'ANTHROPIC_API_KEY',
        credentialProvider: 'native',
      },
    },
    cacheSupport: {
      prompt: {
        mode: 'anthropic_cache_control',
        automatic: false,
        requestControl: 'cache_control_blocks',
        ttlOptions: ['5m', '1h'],
        minimumTokenThresholds: [
          { modelFamily: 'claude-opus-4.6+', tokens: 4096 },
          { modelFamily: 'claude-sonnet-4.6', tokens: 2048 },
          { modelFamily: 'claude-haiku-4.5', tokens: 4096 },
        ],
        usageFields: {
          readTokens: 'cache_read_input_tokens',
          writeTokens: 'cache_creation_input_tokens',
        },
      },
      response: {
        mode: 'none',
        enabledByDefault: false,
        requestControl: 'none',
        requestHeaders: [],
        responseHeaders: [],
        usageBehavior: 'normal_usage',
      },
    },
    executionProviderIds: ['anthropic:claude-agent-sdk'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    executable: true,
    modelRoute: true,
    embeddingProvider: false,
    responseFamily: 'anthropic',
    supportedWorkloads: [
      'chat',
      'one_time_job',
      'recurring_job',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ],
    credentialSchema: {
      version: 1,
      fields: [
        {
          name: 'apiKey',
          label: 'OpenRouter API key',
          secret: true,
          required: true,
        },
      ],
    },
    gateway: {
      pathSegment: 'openrouter',
      upstreamOrigin: 'https://openrouter.ai',
      upstreamPathPrefix: '/api',
      stripRequestHeaders: MODEL_GATEWAY_STRIP_REQUEST_HEADERS,
      auth: {
        type: 'bearer',
        field: 'apiKey',
      },
      sdkProjection: {
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        tokenEnv: 'ANTHROPIC_API_KEY',
        additionalTokenEnv: 'ANTHROPIC_AUTH_TOKEN',
        credentialProviderEnvKey: 'ANTHROPIC_AUTH_TOKEN',
        credentialProvider: 'openrouter',
      },
    },
    cacheSupport: {
      prompt: {
        mode: 'openrouter_anthropic_cache_control',
        automatic: false,
        requestControl: 'cache_control_blocks',
        ttlOptions: ['5m', '1h'],
        minimumTokenThresholds: [
          { modelFamily: 'anthropic-compatible', tokens: 2048 },
        ],
        usageFields: {
          readTokens: 'prompt_tokens_details.cached_tokens',
          writeTokens: 'prompt_tokens_details.cache_write_tokens',
        },
      },
      response: {
        mode: 'openrouter_response_cache',
        enabledByDefault: false,
        requestControl: 'request_header',
        requestHeaders: [
          'X-OpenRouter-Cache',
          'X-OpenRouter-Cache-TTL',
          'X-OpenRouter-Cache-Clear',
        ],
        responseHeaders: [
          'X-OpenRouter-Cache-Status',
          'X-OpenRouter-Cache-Age',
          'X-OpenRouter-Cache-TTL',
        ],
        usageBehavior: 'zero_usage_on_hit',
      },
    },
    executionProviderIds: ['anthropic:claude-agent-sdk'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    executable: true,
    modelRoute: false,
    embeddingProvider: true,
    responseFamily: 'openai',
    supportedWorkloads: [],
    credentialSchema: {
      version: 1,
      fields: [
        {
          name: 'apiKey',
          label: 'OpenAI API key',
          secret: true,
          required: true,
        },
      ],
    },
    gateway: {
      pathSegment: 'openai',
      upstreamOrigin: 'https://api.openai.com',
      upstreamPathPrefix: '',
      stripRequestHeaders: MODEL_GATEWAY_STRIP_REQUEST_HEADERS,
      auth: {
        type: 'bearer',
        field: 'apiKey',
      },
      sdkProjection: {
        baseUrlEnv: 'OPENAI_BASE_URL',
        tokenEnv: 'OPENAI_API_KEY',
        credentialProviderEnvKey: 'OPENAI_API_KEY',
        credentialProvider: 'native',
      },
    },
    cacheSupport: {
      prompt: {
        mode: 'openai_automatic_prefix',
        automatic: true,
        requestControl: 'provider_automatic_prefix',
        ttlOptions: [],
        minimumTokenThresholds: [{ modelFamily: 'openai', tokens: 1024 }],
        usageFields: {
          readTokens: 'prompt_tokens_details.cached_tokens',
        },
      },
      response: {
        mode: 'none',
        enabledByDefault: false,
        requestControl: 'none',
        requestHeaders: [],
        responseHeaders: [],
        usageBehavior: 'normal_usage',
      },
    },
    executionProviderIds: [],
  },
] as const satisfies readonly ModelProviderDefinition[];

const PROVIDER_BY_ID = indexProviderDefinitionsById(MODEL_PROVIDER_DEFINITIONS);
const PROVIDER_BY_GATEWAY_PATH = indexProviderDefinitionsByGatewayPath(
  MODEL_PROVIDER_DEFINITIONS,
);
const EXECUTABLE_MODEL_PROVIDERS = MODEL_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.executable,
);
const MODEL_ROUTE_PROVIDERS = MODEL_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.modelRoute,
);
const EMBEDDING_MODEL_PROVIDERS = MODEL_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.embeddingProvider,
);

export type ModelProviderId = (typeof MODEL_PROVIDER_DEFINITIONS)[number]['id'];
export type ModelRouteProviderId = Extract<
  (typeof MODEL_PROVIDER_DEFINITIONS)[number],
  { modelRoute: true }
>['id'];

export function listModelProviderDefinitions(): readonly ModelProviderDefinition[] {
  return MODEL_PROVIDER_DEFINITIONS;
}

export function listExecutableModelProviders(): readonly ModelProviderDefinition[] {
  return EXECUTABLE_MODEL_PROVIDERS;
}

export function listModelRouteProviders(): readonly ModelProviderDefinition[] {
  return MODEL_ROUTE_PROVIDERS;
}

export function getDefaultModelRouteProvider():
  | ModelProviderDefinition
  | undefined {
  return MODEL_ROUTE_PROVIDERS[0];
}

export function listEmbeddingModelProviders(): readonly ModelProviderDefinition[] {
  return EMBEDDING_MODEL_PROVIDERS;
}

export function getDefaultEmbeddingModelProvider():
  | ModelProviderDefinition
  | undefined {
  return EMBEDDING_MODEL_PROVIDERS[0];
}

export function getModelProviderDefinition(
  providerId: string,
): ModelProviderDefinition | undefined {
  return PROVIDER_BY_ID.get(providerId.trim().toLowerCase());
}

export function getModelProviderByGatewayPath(
  pathSegment: string,
): ModelProviderDefinition | undefined {
  return PROVIDER_BY_GATEWAY_PATH.get(pathSegment.trim().toLowerCase());
}

export function normalizeModelProviderId(providerId: string): ModelProviderId {
  const normalized = providerId.trim().toLowerCase();
  if (getModelProviderDefinition(normalized)) {
    return normalized as ModelProviderId;
  }
  throw new Error(
    `Model credential provider must be one of ${listExecutableModelProviders()
      .map((provider) => provider.id)
      .join(', ')}.`,
  );
}

export function normalizeModelRouteProviderId(
  providerId: string,
): ModelRouteProviderId {
  const normalized = normalizeModelProviderId(providerId);
  const definition = getModelProviderDefinition(normalized);
  if (definition?.modelRoute) return normalized as ModelRouteProviderId;
  throw new Error(`Model provider ${providerId} is not a model route.`);
}

export function normalizeModelCredentialPayload(input: {
  providerId: string;
  payload: unknown;
}): ModelCredentialPayload {
  const provider = getModelProviderDefinition(
    normalizeModelProviderId(input.providerId),
  );
  if (!provider) {
    throw new Error(`Unsupported model provider: ${input.providerId}`);
  }
  if (
    !input.payload ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  ) {
    throw new Error(`Credential payload is required for ${provider.id}.`);
  }
  const rawPayload = input.payload as Record<string, unknown>;
  const allowed = new Set(
    provider.credentialSchema.fields.map((field) => field.name),
  );
  for (const key of Object.keys(rawPayload)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Credential field ${key} is not supported for ${provider.id}.`,
      );
    }
  }
  const payload: ModelCredentialPayload = {};
  for (const field of provider.credentialSchema.fields) {
    const value = rawPayload[field.name];
    if (typeof value === 'string' && value.trim()) {
      payload[field.name] = value.trim();
      continue;
    }
    if (field.required) {
      throw new Error(
        `Credential field ${field.name} is required for ${provider.id}.`,
      );
    }
  }
  return payload;
}

export function singleSecretPayload(input: {
  providerId: string;
  value: string;
}): ModelCredentialPayload {
  const provider = getModelProviderDefinition(
    normalizeModelProviderId(input.providerId),
  );
  const field = provider?.credentialSchema.fields.find((item) => item.secret);
  if (!provider || !field) {
    throw new Error(`Model provider ${input.providerId} has no secret field.`);
  }
  return normalizeModelCredentialPayload({
    providerId: provider.id,
    payload: { [field.name]: input.value },
  });
}

function indexProviderDefinitionsById(
  providers: readonly ModelProviderDefinition[],
): ReadonlyMap<string, ModelProviderDefinition> {
  const indexed = new Map<string, ModelProviderDefinition>();
  for (const provider of providers) {
    if (indexed.has(provider.id)) {
      throw new Error(`Duplicate model provider id: ${provider.id}`);
    }
    indexed.set(provider.id, provider);
  }
  return indexed;
}

function indexProviderDefinitionsByGatewayPath(
  providers: readonly ModelProviderDefinition[],
): ReadonlyMap<string, ModelProviderDefinition> {
  const indexed = new Map<string, ModelProviderDefinition>();
  for (const provider of providers) {
    const path = provider.gateway.pathSegment;
    if (indexed.has(path)) {
      throw new Error(`Duplicate model gateway path segment: ${path}`);
    }
    indexed.set(path, provider);
  }
  return indexed;
}
