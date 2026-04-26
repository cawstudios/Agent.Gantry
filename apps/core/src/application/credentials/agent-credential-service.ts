import { DATA_DIR, getHostCredentialEnv } from '../../config/index.js';
import type { HostCredentialMode } from '../../config/credentials/mode.js';
import type {
  AgentCredentialInjection,
  CredentialBrokerProfile,
} from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { validateExternalBrokerUrl } from '../../config/credentials/broker-url-policy.js';
import { isCredentialBrokerBoundaryError } from '../../domain/models/credential-errors.js';

export interface AgentCredentialServiceOptions {
  mode: HostCredentialMode;
  broker?: AgentCredentialBroker;
  onecliUrl?: string;
  externalBrokerUrl?: string;
  dataDir?: string;
  env?: Partial<Record<string, string | undefined>>;
}

export async function createAgentCredentialBroker(
  options: AgentCredentialServiceOptions,
): Promise<AgentCredentialBroker | undefined> {
  if (options.broker) return options.broker;
  if (options.mode !== 'onecli') return undefined;
  const { OnecliAgentCredentialBroker } =
    await import('../../adapters/credentials/onecli/broker.js');
  return new OnecliAgentCredentialBroker({
    onecliUrl: options.onecliUrl,
    dataDir: options.dataDir ?? DATA_DIR,
  });
}

export async function getAgentCredentialInjection(input: {
  mode: HostCredentialMode;
  agentIdentifier?: string;
  onecliUrl?: string;
  externalBrokerUrl?: string;
  broker?: AgentCredentialBroker;
  env?: Partial<Record<string, string | undefined>>;
}): Promise<AgentCredentialInjection> {
  if (!input.broker && input.mode === 'external') {
    const rawBrokerUrl = input.externalBrokerUrl?.trim() || '';
    if (!rawBrokerUrl) {
      throw new Error(
        'External credential mode is enabled but credential_broker.external.base_url is not configured.',
      );
    }
    const validation = validateExternalBrokerUrl(
      rawBrokerUrl,
      'credential_broker.external.base_url',
    );
    if (!validation.ok || !validation.normalizedUrl) {
      throw new Error(
        validation.error || 'credential_broker.external.base_url is invalid.',
      );
    }
    const env = getHostCredentialEnv({
      ANTHROPIC_BASE_URL: validation.normalizedUrl,
    });
    return {
      env,
      applied: true,
      brokerProfile: 'external',
    };
  }

  const broker = await createAgentCredentialBroker({
    mode: input.mode,
    broker: input.broker,
    onecliUrl: input.onecliUrl,
    env: input.env,
  });
  if (!broker) {
    return {
      env: {},
      applied: false,
      brokerProfile: input.mode as CredentialBrokerProfile,
    };
  }

  try {
    return await broker.getInjection({
      binding: {
        profile: input.mode,
        agentIdentifier: input.agentIdentifier,
      },
    });
  } catch (err) {
    logger.warn(
      { err, agentIdentifier: input.agentIdentifier || 'default' },
      'Agent credential broker not reachable',
    );
    if (isCredentialBrokerBoundaryError(err)) {
      throw err;
    }
    if (input.mode === 'onecli') {
      throw new Error(
        'OneCLI credential mode is enabled but the OneCLI gateway is not reachable.',
        { cause: err },
      );
    }
    return {
      env: {},
      applied: false,
      brokerProfile: input.mode as CredentialBrokerProfile,
    };
  }
}

export async function ensureAgentCredentialBinding(input: {
  mode: HostCredentialMode;
  agentIdentifier: string;
  agentName: string;
  onecliUrl?: string;
  dataDir?: string;
  env?: Partial<Record<string, string | undefined>>;
  broker?: AgentCredentialBroker;
}): Promise<{ created?: boolean } | undefined> {
  if (input.mode !== 'onecli') return undefined;
  const broker = await createAgentCredentialBroker({
    mode: input.mode,
    broker: input.broker,
    onecliUrl: input.onecliUrl,
    dataDir: input.dataDir,
    env: input.env,
  });
  const bindable = broker as
    | (AgentCredentialBroker & {
        ensureAgent?: (agent: {
          name: string;
          identifier: string;
        }) => Promise<{ created?: boolean }>;
      })
    | undefined;
  return bindable?.ensureAgent?.({
    name: input.agentName,
    identifier: input.agentIdentifier,
  });
}
