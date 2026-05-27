import {
  MEMORY_EMBED_BATCH_SIZE,
  MEMORY_EMBED_MODEL,
  MEMORY_EMBED_PROVIDER,
  getCredentialBrokerRuntimeConfig,
} from '../config/index.js';
import { getAgentCredentialInjection } from '../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../adapters/credentials/agent-credential-broker-factory.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import type { AppId } from '../domain/app/app.js';
import {
  getDefaultEmbeddingModelProvider,
  getModelProviderDefinition,
  listEmbeddingModelProviders,
  normalizeModelProviderId,
} from '../shared/model-provider-registry.js';

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export interface EmbeddingProvider {
  isEnabled(): boolean;
  validateConfiguration(): void;
  validateReady?(options?: { signal?: AbortSignal }): Promise<void>;
  embedMany(
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]>;
  embedOne(text: string, options?: { signal?: AbortSignal }): Promise<number[]>;
}

type EmbeddingCredentialResolver = () => Promise<string | null>;
type EmbeddingBaseUrlResolver = () => Promise<string | null>;
type EmbeddingCredentialConfigurationValidator = () => void;
interface EmbeddingProviderOptions {
  model?: string;
}

const embeddingProviderFactories = new Map<
  string,
  (options?: EmbeddingProviderOptions) => EmbeddingProvider
>();
const DEFAULT_APP_ID = 'default' as AppId;
let embeddingCredentialBrokerPromise:
  | ReturnType<typeof createAgentCredentialBroker>
  | undefined;
let embeddingCredentialBrokerConfigKey = '';

export class OpenAIEmbeddingClient implements EmbeddingProvider {
  private readonly apiKey: string | null | EmbeddingCredentialResolver;
  private readonly model: string;
  private readonly validateCredentialConfiguration?: EmbeddingCredentialConfigurationValidator;
  private readonly baseUrl: string | EmbeddingBaseUrlResolver;

  constructor(
    apiKey: string | null | EmbeddingCredentialResolver = null,
    model = MEMORY_EMBED_MODEL,
    validateCredentialConfiguration?: EmbeddingCredentialConfigurationValidator,
    baseUrl: string | EmbeddingBaseUrlResolver = 'https://api.openai.com',
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.validateCredentialConfiguration = validateCredentialConfiguration;
    this.baseUrl = baseUrl;
  }

  isEnabled(): boolean {
    return Boolean(
      this.model.trim() &&
      (typeof this.apiKey === 'function' || this.apiKey?.trim()),
    );
  }

  validateConfiguration(): void {
    if (!this.model.trim()) {
      throw new Error('MEMORY_EMBED_MODEL is required for memory embeddings');
    }
    if (!/embedding/i.test(this.model)) {
      throw new Error(
        `MEMORY_EMBED_MODEL must reference an embedding model, got "${this.model}"`,
      );
    }
    if (typeof this.apiKey === 'function') {
      this.validateCredentialConfiguration?.();
      return;
    }
    if (!this.apiKey?.trim()) {
      throw new Error(
        'Brokered Model Access is required for external memory embeddings',
      );
    }
  }

  private async resolveApiKey(): Promise<string> {
    const apiKey =
      typeof this.apiKey === 'function' ? await this.apiKey() : this.apiKey;
    if (!apiKey?.trim()) {
      throw new Error(
        'Brokered Model Access is required for external memory embeddings',
      );
    }
    return apiKey;
  }

  private async resolveBaseUrl(): Promise<string> {
    const baseUrl =
      typeof this.baseUrl === 'function' ? await this.baseUrl() : this.baseUrl;
    const trimmed = baseUrl?.trim();
    if (!trimmed) {
      throw new Error(
        'Brokered Model Access is required for external memory embeddings',
      );
    }
    return trimmed.replace(/\/+$/, '');
  }

  async validateReady(_options?: { signal?: AbortSignal }): Promise<void> {
    this.validateConfiguration();
    if (typeof this.apiKey === 'function') {
      await this.resolveApiKey();
    }
  }

  async embedMany(
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]> {
    this.validateConfiguration();
    if (texts.length === 0) return [];
    const apiKey = await this.resolveApiKey();
    const baseUrl = await this.resolveBaseUrl();

    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += MEMORY_EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + MEMORY_EMBED_BATCH_SIZE);
      const res = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: options?.signal,
        body: JSON.stringify({
          model: this.model,
          input: batch,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `embedding request failed (${res.status}): ${text.slice(0, 200)}`,
        );
      }

      const json = (await res.json()) as EmbeddingResponse;
      if (!Array.isArray(json.data) || json.data.length !== batch.length) {
        throw new Error(
          `embedding response size mismatch: expected ${batch.length}, got ${json.data?.length ?? 0}`,
        );
      }
      for (const row of json.data) {
        if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
          throw new Error(
            'embedding response contained invalid embedding vector',
          );
        }
        all.push(row.embedding);
      }
    }

    return all;
  }

  async embedOne(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<number[]> {
    const rows = await this.embedMany([text], options);
    if (!rows[0]) {
      throw new Error('embedding response was empty');
    }
    return rows[0];
  }
}

function validateBrokeredEmbeddingConfiguration(): void {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  if (brokerConfig.mode === 'gantry') return;
  throw new Error('Gantry Model Access is required for memory embeddings');
}

function validateEmbeddingProviderDefinition(providerId: string): void {
  const provider = getModelProviderDefinition(providerId);
  if (!provider?.embeddingProvider) {
    throw new Error(
      `Model provider ${providerId} is not registered for memory embeddings.`,
    );
  }
}

async function resolveBrokeredEmbeddingApiKey(
  providerId: string,
): Promise<string | null> {
  const injection = await resolveBrokeredEmbeddingInjection(providerId);
  const projection =
    getModelProviderDefinition(providerId)?.gateway.sdkProjection;
  return projection ? (injection?.env[projection.tokenEnv] ?? null) : null;
}

async function resolveBrokeredEmbeddingBaseUrl(
  providerId: string,
): Promise<string | null> {
  const injection = await resolveBrokeredEmbeddingInjection(providerId);
  const projection =
    getModelProviderDefinition(providerId)?.gateway.sdkProjection;
  return projection ? (injection?.env[projection.baseUrlEnv] ?? null) : null;
}

async function resolveBrokeredEmbeddingInjection(providerId: string) {
  validateEmbeddingProviderDefinition(providerId);
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  if (brokerConfig.mode !== 'gantry') return null;
  const configKey = `${brokerConfig.mode}:${brokerConfig.gatewayBindHost}`;
  if (embeddingCredentialBrokerConfigKey !== configKey) {
    embeddingCredentialBrokerPromise = undefined;
    embeddingCredentialBrokerConfigKey = configKey;
  }
  return resolveBrokeredEmbeddingInjectionFromBroker({
    mode: 'gantry',
    gatewayBindHost: brokerConfig.gatewayBindHost,
    providerId,
  });
}

async function resolveBrokeredEmbeddingInjectionFromBroker(brokerConfig: {
  mode: 'gantry';
  gatewayBindHost: string;
  providerId: string;
}) {
  embeddingCredentialBrokerPromise ??= createAgentCredentialBroker({
    mode: brokerConfig.mode,
    modelCredentials: getRuntimeStorage().repositories.modelCredentials,
    gatewayBindHost: brokerConfig.gatewayBindHost,
    publishRuntimeEvent: (event) =>
      getRuntimeStorage().runtimeEvents.publish(event),
  }).catch((error) => {
    embeddingCredentialBrokerPromise = undefined;
    throw error;
  });
  const broker = await embeddingCredentialBrokerPromise;
  if (!broker) return null;
  return getAgentCredentialInjection({
    mode: 'gantry',
    purpose: 'model_runtime',
    appId: DEFAULT_APP_ID,
    modelCredentialProviderId: normalizeModelProviderId(
      brokerConfig.providerId,
    ),
    broker,
  });
}

export class DisabledEmbeddingClient implements EmbeddingProvider {
  isEnabled(): boolean {
    return false;
  }

  validateConfiguration(): void {
    // Disabled provider intentionally requires no credentials.
  }

  async embedMany(
    texts: string[],
    _options?: { signal?: AbortSignal },
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    throw new Error('memory embeddings are disabled');
  }

  async embedOne(
    _text: string,
    _options?: { signal?: AbortSignal },
  ): Promise<number[]> {
    throw new Error('memory embeddings are disabled');
  }
}

export function registerEmbeddingProvider(
  name: string,
  factory: (options?: EmbeddingProviderOptions) => EmbeddingProvider,
): void {
  embeddingProviderFactories.set(name, factory);
}

export function isEmbeddingProviderRegistered(name: string): boolean {
  return embeddingProviderFactories.has(name);
}

export function listEmbeddingProviderNames(): string[] {
  return [...embeddingProviderFactories.keys()].sort();
}

export function createEmbeddingProvider(
  providerName = MEMORY_EMBED_PROVIDER,
  options: EmbeddingProviderOptions = {},
): EmbeddingProvider {
  const factory = embeddingProviderFactories.get(providerName);
  if (!factory) {
    throw new Error(
      `Unknown memory embedding provider "${providerName}". Registered providers: ${[...embeddingProviderFactories.keys()].join(', ') || 'none'}`,
    );
  }
  return factory(options);
}

export async function validateEmbeddingProviderReady(
  providerName = MEMORY_EMBED_PROVIDER,
): Promise<void> {
  const provider = createEmbeddingProvider(providerName);
  provider.validateConfiguration();
  await provider.validateReady?.();
}

for (const provider of listEmbeddingModelProviders()) {
  registerEmbeddingProvider(
    provider.id,
    (options) =>
      new OpenAIEmbeddingClient(
        () => resolveBrokeredEmbeddingApiKey(provider.id),
        options?.model || MEMORY_EMBED_MODEL,
        () => {
          validateBrokeredEmbeddingConfiguration();
          validateEmbeddingProviderDefinition(provider.id);
        },
        () => resolveBrokeredEmbeddingBaseUrl(provider.id),
      ),
  );
}
const defaultEmbeddingProvider = getDefaultEmbeddingModelProvider();
if (defaultEmbeddingProvider && defaultEmbeddingProvider.id !== 'openai') {
  registerEmbeddingProvider(
    'openai',
    (options) =>
      new OpenAIEmbeddingClient(
        () => resolveBrokeredEmbeddingApiKey(defaultEmbeddingProvider.id),
        options?.model || MEMORY_EMBED_MODEL,
        () => {
          validateBrokeredEmbeddingConfiguration();
          validateEmbeddingProviderDefinition(defaultEmbeddingProvider.id);
        },
        () => resolveBrokeredEmbeddingBaseUrl(defaultEmbeddingProvider.id),
      ),
  );
}
registerEmbeddingProvider('disabled', () => new DisabledEmbeddingClient());
