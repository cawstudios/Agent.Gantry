import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import type {
  AgentCredentialBroker,
  AgentCredentialBrokerInput,
  AgentCredentialBrokerCapabilities,
} from '../../../domain/ports/agent-credential-broker.js';
import type {
  AgentCredentialInjection,
  CredentialBrokerHealth,
} from '../../../domain/models/credentials.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import { filterTrustedOnecliEnv } from './env-policy.js';
import { validateOnecliUrl } from './policy.js';

type OneCliClient = Pick<OneCLI, 'getContainerConfig' | 'ensureAgent'>;

export interface OnecliAgentCredentialBrokerOptions {
  onecliUrl?: string;
  dataDir: string;
  client?: OneCliClient;
}

export class OnecliAgentCredentialBroker implements AgentCredentialBroker {
  private readonly client?: OneCliClient;
  private readonly normalizedUrl?: string;
  private readonly urlError?: string;

  constructor(private readonly options: OnecliAgentCredentialBrokerOptions) {
    const rawUrl = options.onecliUrl?.trim() || '';
    if (rawUrl) {
      const validation = validateOnecliUrl(rawUrl);
      if (!validation.ok || !validation.normalizedUrl) {
        this.urlError = validation.error || 'Invalid ONECLI_URL.';
      } else {
        this.normalizedUrl = validation.normalizedUrl;
      }
    }
    this.client =
      options.client ??
      (this.normalizedUrl
        ? new OneCLI({ url: this.normalizedUrl })
        : undefined);
  }

  getCapabilities(): AgentCredentialBrokerCapabilities {
    return {
      profile: 'onecli',
      supportsAgentBinding: true,
      returnsRawSecrets: false,
    };
  }

  async getInjection(
    input: AgentCredentialBrokerInput,
  ): Promise<AgentCredentialInjection> {
    if (!this.client) {
      if (this.urlError) {
        throw new Error(this.urlError);
      }
      throw new Error(
        'OneCLI credential mode is enabled but ONECLI_URL is not configured.',
      );
    }

    const agentIdentifier = input.binding.agentIdentifier;
    const config = await this.client.getContainerConfig(agentIdentifier);
    const { env, droppedKeys } = filterTrustedOnecliEnv(config.env || {});
    if (droppedKeys.length > 0) {
      logger.warn(
        {
          droppedKeys: droppedKeys.sort().slice(0, 20),
          droppedCount: droppedKeys.length,
        },
        'Dropped disallowed OneCLI env keys',
      );
    }
    this.applyCaCertificate(env, config.caCertificate, agentIdentifier);

    return {
      env,
      applied: true,
      brokerProfile: 'onecli',
      proxy: {
        http: env.HTTP_PROXY || env.http_proxy,
        https: env.HTTPS_PROXY || env.https_proxy,
      },
      certificates: {
        nodeExtraCaCertsPath: env.NODE_EXTRA_CA_CERTS,
      },
    };
  }

  async healthCheck(
    input?: AgentCredentialBrokerInput,
  ): Promise<CredentialBrokerHealth> {
    if (!this.client) {
      return {
        status: 'fail',
        message: this.urlError || 'ONECLI_URL is missing.',
        nextAction: 'Set ONECLI_URL to the reachable OneCLI gateway URL.',
      };
    }
    try {
      const binding = input?.binding || { profile: 'onecli' as const };
      const config = await this.client.getContainerConfig(
        binding.agentIdentifier,
      );
      filterTrustedOnecliEnv(config.env || {});
      return {
        status: 'pass',
        message: `Connected to OneCLI at ${this.normalizedUrl}.`,
      };
    } catch (err) {
      return {
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        nextAction: 'Confirm the Model Access URL and gateway availability.',
      };
    }
  }

  async ensureAgent(input: {
    name: string;
    identifier: string;
  }): Promise<{ created?: boolean }> {
    if (!this.client) return {};
    return this.client.ensureAgent(input);
  }

  private applyCaCertificate(
    env: Record<string, string>,
    caCertificate: string | undefined,
    agentIdentifier: string | undefined,
  ): void {
    if (!caCertificate) return;

    const caDir = path.join(this.options.dataDir, 'onecli');
    const caPath = path.join(caDir, 'gateway-ca.pem');
    fs.mkdirSync(caDir, { recursive: true });
    fs.writeFileSync(caPath, caCertificate, { mode: 0o600 });
    env.NODE_EXTRA_CA_CERTS = caPath;
    logger.info(
      { agentIdentifier: agentIdentifier || 'default', caPath },
      'Applied OneCLI CA certificate for host runner',
    );
  }
}
