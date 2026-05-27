import type { AgentCredentialInjection } from '../../../domain/models/credentials.js';
import type { ModelCatalogEntry } from '../../../shared/model-catalog.js';

export function validateModelCredentialProjectionForEntry(input: {
  model: ModelCatalogEntry;
  projection: Pick<AgentCredentialInjection, 'env' | 'credentialProviders'> & {
    brokerProfile?: string;
  };
}): void {
  const { model, projection } = input;
  const isGantryGatewayProjection = projection.brokerProfile === 'gantry';
  if (!isGantryGatewayProjection) {
    throw new Error(
      `Model ${model.displayName} requires Gantry Model Gateway credentials from Model Access. Run \`gantry credentials model set ${model.modelRoute.id}\`.`,
    );
  }
  validateGantryGatewayProjection(projection.env, model);
}

function validateGantryGatewayProjection(
  env: Partial<
    Record<
      'ANTHROPIC_BASE_URL' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN',
      string
    >
  >,
  model: ModelCatalogEntry,
): void {
  if (!isLoopbackGatewayUrl(env.ANTHROPIC_BASE_URL)) {
    throw new Error(
      `Gantry Model Gateway projection for ${model.displayName} must use a loopback ANTHROPIC_BASE_URL.`,
    );
  }
  if (!env.ANTHROPIC_API_KEY?.startsWith('gtw_')) {
    throw new Error(
      `Gantry Model Gateway projection for ${model.displayName} must use a run-scoped gateway token.`,
    );
  }
  if (
    env.ANTHROPIC_AUTH_TOKEN &&
    !env.ANTHROPIC_AUTH_TOKEN.startsWith('gtw_')
  ) {
    throw new Error(
      `Gantry Model Gateway projection for ${model.displayName} must not expose provider auth tokens.`,
    );
  }
}

function isLoopbackGatewayUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}
