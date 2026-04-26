import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCredentialBroker } from '@core/domain/ports/agent-credential-broker.js';
import { CredentialBrokerPolicyError } from '@core/domain/models/credential-errors.js';

function makeBroker(
  overrides: {
    getInjection?: AgentCredentialBroker['getInjection'];
  } = {},
): AgentCredentialBroker {
  return {
    getInjection:
      overrides.getInjection ||
      (async () => ({
        env: {
          ANTHROPIC_BASE_URL: 'https://broker.example.com',
        },
        applied: true,
        brokerProfile: 'onecli',
      })),
    healthCheck: async () => ({
      status: 'pass',
      message: 'ok',
    }),
    getCapabilities: () => ({
      profile: 'onecli',
      supportsAgentBinding: true,
      returnsRawSecrets: false,
    }),
  };
}

async function loadCredentialService() {
  vi.resetModules();
  return import('@core/application/credentials/agent-credential-service.js');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('agent credential service', () => {
  it('throws missing ONECLI_URL only when onecli mode is required', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();

    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        onecliUrl: '',
      }),
    ).rejects.toThrow('ONECLI_URL');

    await expect(
      getAgentCredentialInjection({
        mode: 'none',
        onecliUrl: '',
      }),
    ).resolves.toEqual({
      env: {},
      applied: false,
      brokerProfile: 'none',
    });

    await expect(
      getAgentCredentialInjection({
        mode: 'external',
        onecliUrl: '',
      }),
    ).rejects.toThrow('credential_broker.external.base_url');
  });

  it('passes safe external broker env to spawned agents', async () => {
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'external');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://broker.example.com');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'raw-secret');
    const { getAgentCredentialInjection } = await loadCredentialService();

    await expect(
      getAgentCredentialInjection({
        mode: 'external',
        onecliUrl: '',
        externalBrokerUrl: 'https://broker.example.com',
      }),
    ).resolves.toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      applied: true,
      brokerProfile: 'external',
    });
  });

  it('rejects unsafe external broker URLs before injecting agent env', async () => {
    vi.stubEnv('MYCLAW_CREDENTIAL_MODE', 'external');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://user:pass@broker.example.com');
    const { getAgentCredentialInjection } = await loadCredentialService();

    await expect(
      getAgentCredentialInjection({
        mode: 'external',
        onecliUrl: '',
        externalBrokerUrl: 'https://user:pass@broker.example.com',
      }),
    ).rejects.toThrow(
      'credential_broker.external.base_url must not contain embedded credentials',
    );
  });

  it('keeps broker requests agent-scoped and does not request runtime-owned secrets', async () => {
    const getInjection = vi.fn(async () => ({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      applied: true,
      brokerProfile: 'onecli' as const,
    }));
    const broker = makeBroker({ getInjection });
    const { getAgentCredentialInjection } = await loadCredentialService();

    const result = await getAgentCredentialInjection({
      mode: 'onecli',
      agentIdentifier: 'memory',
      broker,
    });

    expect(result).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      applied: true,
      brokerProfile: 'onecli',
    });
    expect(getInjection).toHaveBeenCalledWith({
      binding: {
        profile: 'onecli',
        agentIdentifier: 'memory',
      },
    });
  });

  it('propagates forbidden raw-secret broker failures and wraps transport failures', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();

    const forbiddenBroker = makeBroker({
      getInjection: async () => {
        throw new CredentialBrokerPolicyError(
          'OneCLI returned forbidden raw credential env key: OPENAI_API_KEY',
        );
      },
    });
    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        broker: forbiddenBroker,
      }),
    ).rejects.toThrow('forbidden raw credential env key: OPENAI_API_KEY');

    const forbiddenValueBroker = makeBroker({
      getInjection: async () => {
        throw new CredentialBrokerPolicyError(
          'OneCLI returned forbidden raw credential env value',
        );
      },
    });
    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        broker: forbiddenValueBroker,
      }),
    ).rejects.toThrow('forbidden raw credential env value');

    const unreachableBroker = makeBroker({
      getInjection: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        broker: unreachableBroker,
      }),
    ).rejects.toThrow(
      'OneCLI credential mode is enabled but the OneCLI gateway is not reachable.',
    );
  });

  it('does not fail-open when a generic broker error mentions policy text', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();
    const broker = makeBroker({
      getInjection: async () => {
        throw new Error('forbidden raw credential env key: OPENAI_API_KEY');
      },
    });

    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        broker,
      }),
    ).rejects.toThrow(
      'OneCLI credential mode is enabled but the OneCLI gateway is not reachable.',
    );
  });
});
