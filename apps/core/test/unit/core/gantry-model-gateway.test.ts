import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

import { GantryModelGatewayBroker } from '@core/adapters/llm/anthropic-claude-agent/gantry-model-gateway.js';
import type { AppId } from '@core/domain/app/app.js';
import type {
  ModelCredential,
  ModelCredentialMetadata,
  ModelCredentialProvider,
} from '@core/domain/model-credentials/model-credentials.js';
import type { ModelCredentialRepository } from '@core/domain/ports/repositories.js';

const appId = 'default' as AppId;

class MutableModelCredentialRepository implements ModelCredentialRepository {
  private readonly rows = new Map<string, ModelCredential>();

  set(providerId: ModelCredentialProvider, value: string): void {
    const now = new Date().toISOString();
    const fingerprint = `fp:${providerId}:${value.length}`;
    this.rows.set(`${appId}:${providerId}`, {
      id: `model-credential:${providerId}` as never,
      appId,
      providerId,
      status: 'active',
      schemaVersion: 1,
      payload: { apiKey: value },
      fingerprint,
      fieldFingerprints: [{ field: 'apiKey', fingerprint }],
      createdAt: now,
      updatedAt: now,
    });
  }

  disable(providerId: ModelCredentialProvider): void {
    const key = `${appId}:${providerId}`;
    const row = this.rows.get(key);
    if (!row) return;
    this.rows.set(key, {
      ...row,
      status: 'disabled',
      updatedAt: new Date().toISOString(),
    });
  }

  async getModelCredential(input: {
    appId: ModelCredential['appId'];
    providerId: ModelCredentialProvider;
  }): Promise<ModelCredential | null> {
    return this.rows.get(`${input.appId}:${input.providerId}`) ?? null;
  }

  async listModelCredentials(input: {
    appId: ModelCredentialMetadata['appId'];
  }): Promise<ModelCredentialMetadata[]> {
    return [...this.rows.values()]
      .filter((row) => row.appId === input.appId)
      .map(({ payload: _payload, ...metadata }) => metadata);
  }

  async upsertModelCredential(): Promise<ModelCredentialMetadata> {
    throw new Error('not needed');
  }

  async disableModelCredential(): Promise<ModelCredentialMetadata | null> {
    throw new Error('not needed');
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function gatewayRequest(input: {
  url: string;
  token: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      input.url,
      {
        method: 'POST',
        headers: {
          'x-api-key': input.token,
          'content-type': 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

function gatewayStreamingRequest(input: { url: string; token: string }): {
  firstChunk: Promise<string>;
  done: Promise<{ status: number; body: string }>;
} {
  let resolveFirstChunk!: (value: string) => void;
  let rejectFirstChunk!: (error: unknown) => void;
  let sawFirstChunk = false;
  const firstChunk = new Promise<string>((resolve, reject) => {
    resolveFirstChunk = resolve;
    rejectFirstChunk = reject;
  });
  const done = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        input.url,
        {
          method: 'POST',
          headers: {
            'x-api-key': input.token,
            'content-type': 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => {
            const buffer = Buffer.from(chunk);
            chunks.push(buffer);
            if (!sawFirstChunk) {
              sawFirstChunk = true;
              resolveFirstChunk(buffer.toString('utf-8'));
            }
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            }),
          );
        },
      );
      req.on('error', (error) => {
        rejectFirstChunk(error);
        reject(error);
      });
      req.end('{}');
    },
  );
  return { firstChunk, done };
}

describe('GantryModelGatewayBroker', () => {
  it('projects only a loopback URL and run-scoped token', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-upstream');
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      expect(injection).toMatchObject({
        applied: true,
        brokerProfile: 'gantry',
        credentialProviders: { ANTHROPIC_API_KEY: 'native' },
      });
      expect(injection.env.ANTHROPIC_BASE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/anthropic$/,
      );
      expect(injection.env.ANTHROPIC_API_KEY).toMatch(/^gtw_/);
      expect(injection.env.ANTHROPIC_API_KEY).not.toContain('sk-ant');
    } finally {
      await broker.close();
    }
  });

  it('honors configured loopback bind hosts only', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-upstream');
    const broker = new GantryModelGatewayBroker(repo, {
      bindHost: 'localhost',
    });
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });
      expect(injection.env.ANTHROPIC_BASE_URL).toMatch(
        /^http:\/\/localhost:\d+\/anthropic$/,
      );
    } finally {
      await broker.close();
    }

    expect(
      () => new GantryModelGatewayBroker(repo, { bindHost: '0.0.0.0' }),
    ).toThrow('loopback host');
  });

  it('authenticates run tokens and hot-loads the latest provider credential', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-old');
    const upstreamFetch = vi.fn(async () => new Response('{"ok":true}'));
    const audit = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo, { audit });
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'run:credential-audit' as never,
          modelRouteId: 'anthropic',
        },
      });
      repo.set('anthropic', 'sk-ant-new');

      const unauthorized = await gatewayRequest({
        url: `${injection.env.ANTHROPIC_BASE_URL}/v1/messages`,
        token: 'gtw_wrong',
      });
      expect(unauthorized.status).toBe(401);

      const response = await gatewayRequest({
        url: `${injection.env.ANTHROPIC_BASE_URL}/v1/messages`,
        token: injection.env.ANTHROPIC_API_KEY!,
      });

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL('https://api.anthropic.com/v1/messages'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'sk-ant-new',
          }),
        }),
      );
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          appId,
          runId: 'run:credential-audit',
          eventType: 'credential.model.used',
          actor: 'gantry-model-gateway',
          payload: expect.objectContaining({
            providerId: 'anthropic',
            outcome: 'forwarded',
            status: 200,
            upstreamHost: 'api.anthropic.com',
            upstreamPath: '/v1/messages',
          }),
        }),
      );
      expect(JSON.stringify(audit.mock.calls)).not.toContain('sk-ant-new');

      await broker.revokeInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId: 'run:credential-audit' as never,
          modelRouteId: 'anthropic',
        },
      });
      const afterRevoke = await gatewayRequest({
        url: `${injection.env.ANTHROPIC_BASE_URL}/v1/messages`,
        token: injection.env.ANTHROPIC_API_KEY!,
      });
      expect(afterRevoke.status).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it('streams upstream provider responses without buffering the full body', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-stream');
    let releaseSecondChunk!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Buffer.from('data: first\n\n'));
                releaseSecondChunk = () => {
                  controller.enqueue(Buffer.from('data: second\n\n'));
                  controller.close();
                };
              },
            }),
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          ),
      ),
    );
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      const response = gatewayStreamingRequest({
        url: `${injection.env.ANTHROPIC_BASE_URL}/v1/messages`,
        token: injection.env.ANTHROPIC_API_KEY!,
      });

      await expect(response.firstChunk).resolves.toBe('data: first\n\n');
      releaseSecondChunk();
      await expect(response.done).resolves.toMatchObject({
        status: 200,
        body: 'data: first\n\ndata: second\n\n',
      });
    } finally {
      await broker.close();
    }
  });

  it('hot-resolves disabled provider credentials after a token is issued', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-active');
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });
      repo.disable('anthropic');

      const response = await gatewayRequest({
        url: `${injection.env.ANTHROPIC_BASE_URL}/v1/messages`,
        token: injection.env.ANTHROPIC_API_KEY!,
      });

      expect(response.status).toBe(503);
      expect(response.body).toContain(
        'No active anthropic model credential is configured',
      );
    } finally {
      await broker.close();
    }
  });

  it('rejects expired run-scoped gateway tokens', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('anthropic', 'sk-ant-upstream');
    const broker = new GantryModelGatewayBroker(repo, { tokenTtlMs: -1 });
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'anthropic',
        },
      });

      const response = await gatewayRequest({
        url: `${injection.env.ANTHROPIC_BASE_URL}/v1/messages`,
        token: injection.env.ANTHROPIC_API_KEY!,
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain('Expired model gateway token');
    } finally {
      await broker.close();
    }
  });

  it('fails closed when a route credential is missing', async () => {
    const broker = new GantryModelGatewayBroker(
      new MutableModelCredentialRepository(),
    );

    await expect(
      broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelRouteId: 'openrouter',
        },
      }),
    ).rejects.toThrow('gantry credentials model set openrouter');
  });

  it('proxies OpenAI embedding traffic through the same gateway boundary', async () => {
    const repo = new MutableModelCredentialRepository();
    repo.set('openai', 'sk-openai-upstream');
    const upstreamFetch = vi.fn(async () => new Response('{"data":[]}'));
    vi.stubGlobal('fetch', upstreamFetch);
    const broker = new GantryModelGatewayBroker(repo);
    try {
      const injection = await broker.getInjection({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          modelCredentialProviderId: 'openai',
        },
      });

      expect(injection.env.OPENAI_BASE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/openai$/,
      );
      expect(injection.env.OPENAI_API_KEY).toMatch(/^gtw_/);
      const response = await gatewayRequest({
        url: `${injection.env.OPENAI_BASE_URL}/v1/embeddings`,
        token: injection.env.OPENAI_API_KEY!,
      });

      expect(response.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        new URL('https://api.openai.com/v1/embeddings'),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer sk-openai-upstream',
          }),
        }),
      );
    } finally {
      await broker.close();
    }
  });
});
