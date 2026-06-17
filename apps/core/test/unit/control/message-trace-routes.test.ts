import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { Scope } from '@core/control/server/auth.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { handleMessageTraceRoutes } from '@core/control/server/routes/message-traces.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

type TestResponse = ServerResponse & {
  body: string;
  headers: Record<string, string>;
};

function responseRecorder(): TestResponse {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    setHeader(name: string, value: number | string | string[]) {
      this.headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(', ')
        : String(value);
      return this;
    },
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as TestResponse;
}

function request(options: {
  method: string;
  authorization?: string | null;
}): IncomingMessage {
  return {
    method: options.method,
    headers:
      options.authorization === undefined
        ? { authorization: 'Bearer test-token' }
        : options.authorization === null
          ? {}
          : { authorization: options.authorization },
    on: () => undefined,
    once: () => undefined,
  } as unknown as IncomingMessage;
}

function mockContext(
  scopes: Scope[] = ['messages:admin'],
): ControlRouteContext {
  return {
    app: {} as ControlRouteContext['app'],
    runtimeHome: '/tmp/gantry-test',
    keys: [
      {
        kid: 'trace-admin',
        tokenHash: createHash('sha256').update('test-token').digest(),
        scopes: new Set(scopes),
        appId: 'default',
      },
    ],
    socketPath: '/tmp/gantry-control.sock',
    port: 8787,
    maxConcurrentStreams: 25,
    maxConcurrentWaits: 50,
    maxConcurrentTriggerWaits: 50,
    state: { activeStreams: 0, activeWaits: 0, activeTriggerWaits: 0 },
    triggerRateLimiter: { consume: () => true },
    getRuntimeSettings: () =>
      ({}) as ReturnType<ControlRouteContext['getRuntimeSettings']>,
    getDefaultModelConfig: () => ({ source: 'test' }),
    getModelDefaults: () =>
      ({ defaults: {} }) as ReturnType<ControlRouteContext['getModelDefaults']>,
    patchModelDefaults: () => ({ ok: true }),
    preflightModelPreset: async () => ({
      ok: true,
      status: 'pass',
      message: 'ok',
    }),
    getMessageTracePayloads: vi.fn(async () => ({
      messageId: 'message:wa:42:outbound:1',
      appId: 'default',
      conversationId: 'wa:42',
      payloadsJson: { 0: { cache: { output: { ok: true } } } },
      createdAt: '2026-06-17T12:00:00.000Z',
    })),
    publishRuntimeEvent: vi.fn(async () => undefined),
    syncSettingsFromProjection: async () => undefined,
  };
}

describe('message trace control routes', () => {
  it('requires messages:admin to read exact trace payloads', async () => {
    const res = responseRecorder();

    const handled = await handleMessageTraceRoutes(
      request({ method: 'GET' }),
      res,
      mockContext(['messages:read']),
      new URL(
        'http://localhost/v1/messages/message%3Awa%3A42%3Aoutbound%3A1/trace-payloads',
      ),
      '/v1/messages/message%3Awa%3A42%3Aoutbound%3A1/trace-payloads',
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.message).toBe(
      'API key is missing required scope messages:admin',
    );
  });

  it('returns payloads through Gantry and audits exact-payload reads', async () => {
    const res = responseRecorder();
    const ctx = mockContext();

    const handled = await handleMessageTraceRoutes(
      request({ method: 'GET' }),
      res,
      ctx,
      new URL(
        'http://localhost/v1/messages/message%3Awa%3A42%3Aoutbound%3A1/trace-payloads',
      ),
      '/v1/messages/message%3Awa%3A42%3Aoutbound%3A1/trace-payloads',
    );

    expect(handled).toBe(true);
    expect(ctx.getMessageTracePayloads).toHaveBeenCalledWith({
      appId: 'default',
      messageId: 'message:wa:42:outbound:1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      payloads: { 0: { cache: { output: { ok: true } } } },
    });
    expect(ctx.publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        conversationId: 'wa:42',
        eventType: RUNTIME_EVENT_TYPES.TRACE_PAYLOAD_READ,
        actor: 'control:trace-admin',
        payload: {
          messageId: 'message:wa:42:outbound:1',
          payloadsAvailable: true,
        },
      }),
    );
  });
});
