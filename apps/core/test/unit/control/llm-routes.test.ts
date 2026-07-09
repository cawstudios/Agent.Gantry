import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { handleLlmRoutes } from '@core/control/server/routes/llm.js';
import {
  configureControlRequestLogSink,
  type ControlRequestLogEntry,
} from '@core/control/server/http.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { Scope } from '@core/shared/control-api-keys.js';
import type { AgentCredentialBroker } from '@core/domain/ports/agent-credential-broker.js';

const TOKEN = 'llm-route-token';
const messagesProviderEnvPrefix = ['ANTH', 'ROPIC'].join('');
const chatProviderEnvPrefix = ['OPEN', 'AI'].join('');
const messagesBaseUrlKey = [messagesProviderEnvPrefix, 'BASE_URL'].join('_');
const messagesTokenKey = [messagesProviderEnvPrefix, 'API_KEY'].join('_');
const chatBaseUrlKey = [chatProviderEnvPrefix, 'BASE_URL'].join('_');
const chatTokenKey = [chatProviderEnvPrefix, 'API_KEY'].join('_');

class TestResponse extends Writable {
  statusCode = 0;
  readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: number | string | string[]) {
    this.headers[name.toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : String(value);
    return this;
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

let restoreLogSink: () => void = () => undefined;
let requestLogs: ControlRequestLogEntry[] = [];

beforeEach(() => {
  requestLogs = [];
  restoreLogSink = configureControlRequestLogSink((entry) => {
    requestLogs.push(entry);
  });
});

afterEach(() => {
  restoreLogSink();
  vi.unstubAllGlobals();
});

function request(input: {
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const raw =
    typeof input.body === 'string'
      ? input.body
      : JSON.stringify(input.body ?? {});
  const req = Readable.from([raw]) as unknown as IncomingMessage;
  req.method = 'POST';
  req.headers = {
    authorization: `Bearer ${input.token ?? TOKEN}`,
    'content-type': 'application/json',
    ...(input.headers ?? {}),
  };
  return req;
}

function apiKey(scopes: Scope[] = ['llm:invoke']) {
  return {
    kid: 'llm-key',
    tokenHash: createHash('sha256').update(TOKEN).digest(),
    scopes: new Set(scopes),
    appId: 'app-one',
  };
}

function broker(): AgentCredentialBroker {
  return {
    getInjection: vi.fn(async (input) => {
      const route = input.binding.modelRouteId;
      return {
        env:
          route === 'anthropic'
            ? {
                [messagesBaseUrlKey]: 'http://127.0.0.1:9000/anthropic',
                [messagesTokenKey]: 'gtw_anthropic',
              }
            : {
                [chatBaseUrlKey]: `http://127.0.0.1:9000/${route}`,
                [chatTokenKey]: 'gtw_openai',
              },
        applied: true,
        brokerProfile: 'gantry',
      };
    }),
    revokeInjection: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({
      status: 'pass',
      message: 'ok',
    })),
    getCapabilities: () => ({
      profile: 'gantry',
      supportsAgentBinding: false,
      returnsRawSecrets: true,
    }),
  };
}

function context(input: {
  broker: AgentCredentialBroker;
  scopes?: Scope[];
  consume?: boolean;
}): ControlRouteContext {
  return {
    app: {
      getCredentialBroker: async () => input.broker,
    } as RuntimeApp,
    runtimeHome: '/tmp/gantry',
    keys: [apiKey(input.scopes)],
    processRole: 'all',
    liveExecution: true,
    roleReadinessRequirements: {
      requiresApiAuthConfigured: false,
      requiresWorkerRegistration: false,
      requiresSchedulerClaiming: false,
      requiresLiveCapacitySignal: false,
    },
    socketPath: '/tmp/gantry/control.sock',
    port: 0,
    maxConcurrentStreams: 25,
    maxConcurrentWaits: 50,
    maxConcurrentTriggerWaits: 50,
    state: { activeStreams: 0, activeWaits: 0, activeTriggerWaits: 0 },
    triggerRateLimiter: {
      consume: vi.fn(() => input.consume ?? true),
    },
    getRuntimeSettings: () => ({}) as never,
    getInternalRuntimeSettings: () => ({}) as never,
    getDefaultModelConfig: () => ({ source: 'test' }),
    getModelDefaults: () => ({ defaults: {} }) as never,
    patchModelDefaults: async () => ({ ok: true }),
    preflightModelProvider: async () => ({
      ok: true,
      status: 'pass',
      message: 'ok',
    }),
    getActiveModelCredentialProviderIds: async () => [],
    countPendingAccessRequests: async () => 0,
    listControlPlaneJobs: async () => [],
    syncSettingsFromProjection: async () => undefined,
    getSelectedAgentHarness: () => 'auto',
  };
}

describe('direct LLM control routes', () => {
  it('forwards Anthropic Messages requests through an API-key-scoped gateway token', async () => {
    const gatewayBroker = broker();
    const fetchMock = vi.fn(
      async () =>
        new Response('{"id":"msg_1"}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req_1',
            authorization: 'must-not-forward',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const req = request({
      body: {
        model: 'sonnet',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      },
      headers: { 'anthropic-version': '2023-06-01' },
    });
    const res = new TestResponse();

    await expect(
      handleLlmRoutes(
        req,
        res as unknown as ServerResponse,
        context({ broker: gatewayBroker }),
        '/llm/v1/messages',
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['x-request-id']).toBe('req_1');
    expect(res.headers.authorization).toBeUndefined();
    expect(res.body()).toBe('{"id":"msg_1"}');

    expect(gatewayBroker.getInjection).toHaveBeenCalledWith({
      binding: expect.objectContaining({
        appId: 'app-one',
        apiKeyId: 'llm-key',
        modelRouteId: 'anthropic',
      }),
    });
    expect(gatewayBroker.getInjection).toHaveBeenCalledWith({
      binding: expect.not.objectContaining({ runId: expect.anything() }),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/anthropic/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer gtw_anthropic',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
    const upstreamBody = JSON.parse(
      Buffer.from(fetchMock.mock.calls[0]![1]!.body as Buffer).toString('utf8'),
    );
    expect(upstreamBody.model).toBe('claude-sonnet-4-6');
    expect(gatewayBroker.revokeInjection).toHaveBeenCalledWith({
      binding: expect.objectContaining({
        apiKeyId: 'llm-key',
        modelRouteId: 'anthropic',
      }),
    });
    expect(requestLogs).toContainEqual(
      expect.objectContaining({
        route: '/llm/v1/messages',
        apiKeyId: 'llm-key',
        appId: 'app-one',
        modelAlias: 'sonnet',
        modelRouteId: 'anthropic',
        statusCode: 200,
      }),
    );
  });

  it('forwards OpenAI Chat Completions streaming responses without buffering', async () => {
    const gatewayBroker = broker();
    const fetchMock = vi.fn(
      async () =>
        new Response('data: {"choices":[]}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const req = request({
      body: {
        model: 'gpt',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    const res = new TestResponse();

    await handleLlmRoutes(
      req,
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/chat/completions',
    );

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body()).toBe('data: {"choices":[]}\n\n');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/openai/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer gtw_openai',
        }),
      }),
    );
    const upstreamBody = JSON.parse(
      Buffer.from(fetchMock.mock.calls[0]![1]!.body as Buffer).toString('utf8'),
    );
    expect(upstreamBody.model).toBe('gpt-5.5');
  });

  it('rejects invalid keys before broker access', async () => {
    const gatewayBroker = broker();
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model: 'sonnet' }, token: 'wrong' }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/messages',
    );

    expect(res.statusCode).toBe(401);
    expect(gatewayBroker.getInjection).not.toHaveBeenCalled();
  });

  it('requires llm:invoke scope', async () => {
    const gatewayBroker = broker();
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model: 'sonnet' } }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker, scopes: ['sessions:read'] }),
      '/llm/v1/messages',
    );

    expect(res.statusCode).toBe(403);
    expect(res.body()).toContain('llm:invoke');
    expect(gatewayBroker.getInjection).not.toHaveBeenCalled();
  });

  it('rejects raw provider model ids', async () => {
    const gatewayBroker = broker();
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model: 'claude-sonnet-4-6' } }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/messages',
    );

    expect(res.statusCode).toBe(400);
    expect(res.body()).toContain('Provider model ID');
    expect(gatewayBroker.getInjection).not.toHaveBeenCalled();
  });

  it('rejects models on the wrong endpoint shape', async () => {
    const gatewayBroker = broker();
    const res = new TestResponse();

    await handleLlmRoutes(
      request({ body: { model: 'sonnet' } }),
      res as unknown as ServerResponse,
      context({ broker: gatewayBroker }),
      '/llm/v1/chat/completions',
    );

    expect(res.statusCode).toBe(400);
    expect(res.body()).toContain('Chat Completions');
    expect(gatewayBroker.getInjection).not.toHaveBeenCalled();
  });
});
