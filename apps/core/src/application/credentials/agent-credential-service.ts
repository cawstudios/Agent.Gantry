import {
  DATA_DIR,
  getHostCredentialEnv,
  hasHostCredentialBrokerEnv,
} from '../../config/index.js';
import type { HostCredentialMode } from '../../config/credentials/mode.js';
import { runtimeEnvValue } from '../../config/env/index.js';
import type {
  AgentCredentialInjection,
  CredentialBrokerProfile,
} from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { validateExternalBrokerUrl } from '../../config/credentials/broker-url-policy.js';

export interface AgentCredentialServiceOptions {
  mode: HostCredentialMode;
  broker?: AgentCredentialBroker;
  onecliUrl?: string;
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
    onecliUrl:
      options.onecliUrl ??
      options.env?.ONECLI_URL?.trim() ??
      runtimeEnvValue('ONECLI_URL'),
    dataDir: options.dataDir ?? DATA_DIR,
  });
}

export async function getAgentCredentialInjection(input: {
  mode: HostCredentialMode;
  agentIdentifier?: string;
  onecliUrl?: string;
  broker?: AgentCredentialBroker;
  env?: Partial<Record<string, string | undefined>>;
}): Promise<AgentCredentialInjection> {
  if (!input.broker && input.mode === 'external') {
    if (!hasHostCredentialBrokerEnv(input.env)) {
      throw new Error(
        'External credential mode is enabled but ANTHROPIC_BASE_URL is not configured.',
      );
    }
    const env = getHostCredentialEnv(input.env);
    const validation = validateExternalBrokerUrl(env.ANTHROPIC_BASE_URL || '');
    if (!validation.ok || !validation.normalizedUrl) {
      throw new Error(validation.error || 'ANTHROPIC_BASE_URL is invalid.');
    }
    env.ANTHROPIC_BASE_URL = validation.normalizedUrl;
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
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, agentIdentifier: input.agentIdentifier || 'default' },
      'Agent credential broker not reachable',
    );
    if (
      message.includes('forbidden raw credential env key') ||
      message.includes('forbidden raw credential env value') ||
      message.includes('ONECLI_URL')
    ) {
      throw err;
    }
    if (input.mode === 'onecli') {
      throw new Error(
        'OneCLI credential mode is enabled but the OneCLI gateway is not reachable.',
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
