import http from 'node:http';
import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MyClawClient,
  verifyWebhookSignature,
} from '../../../../../packages/sdk/src/index.js';

let server: http.Server | null = null;

function listen(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not bind SDK test server'));
        return;
      }
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  const existing = server;
  server = null;
  if (!existing) return;
  await new Promise<void>((resolve, reject) => {
    existing.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('@myclaw/sdk webhook verification', () => {
  it('rejects stale signatures by default', () => {
    const timestamp = String(Date.now() - 10 * 60_000);
    const eventId = 'event-1';
    const eventType = 'session.message.outbound';
    const rawBody = JSON.stringify({ ok: true });
    const signature = createHmac('sha256', 'secret')
      .update(`${timestamp}.${eventId}.${eventType}.${rawBody}`)
      .digest('hex');

    expect(
      verifyWebhookSignature({
        secret: 'secret',
        timestamp,
        eventId,
        eventType,
        rawBody,
        signature,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });
});

describe('@myclaw/sdk transport', () => {
  it('does not send an undefined content-type header for GET requests', async () => {
    const port = await listen((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.headers.authorization).toBe('Bearer test-key');
      expect(req.headers['content-type']).toBeUndefined();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    const client = new MyClawClient({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
    });

    await expect(client.health()).resolves.toEqual({ status: 'ok' });
  });

  it('sends JSON content-type for POST requests with a body', async () => {
    const port = await listen((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessionId: 'session-1' }));
    });
    const client = new MyClawClient({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
    });

    await expect(
      client.sessions.ensure({
        appId: 'app-one',
        conversationId: 'conv-one',
      }),
    ).resolves.toEqual({ sessionId: 'session-1' });
  });

  it('builds channel onboarding and binding requests', async () => {
    const seen: Array<{ method?: string; url?: string; body: unknown }> = [];
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        seen.push({
          method: req.method,
          url: req.url,
          body: raw ? JSON.parse(raw) : null,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, conversations: [], bindings: [] }));
      });
    });
    const client = new MyClawClient({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
    });

    await client.channels.providers.list();
    await client.channels.installations.create({
      appId: 'app-one',
      providerId: 'slack',
      label: 'Slack',
      runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
    });
    await client.channels.installations.discover('installation/1', {
      limit: 10,
    });
    await client.channels.conversations.messages('conversation/1', {
      threadId: 'thread/1',
      limit: 5,
    });
    await client.agents.bindings.enable('agent/1', 'conversation/1', {
      triggerMode: 'mention',
      memoryScope: 'conversation',
    });
    await client.agents.bindings.disable('agent/1', 'conversation/1');

    expect(seen).toEqual([
      { method: 'GET', url: '/v1/channel-providers', body: null },
      {
        method: 'POST',
        url: '/v1/channel-installations',
        body: {
          appId: 'app-one',
          providerId: 'slack',
          label: 'Slack',
          runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
        },
      },
      {
        method: 'POST',
        url: '/v1/channel-installations/installation%2F1/discover',
        body: { limit: 10 },
      },
      {
        method: 'GET',
        url: '/v1/conversations/conversation%2F1/messages?threadId=thread%2F1&limit=5',
        body: null,
      },
      {
        method: 'PUT',
        url: '/v1/agents/agent%2F1/channel-bindings/conversation%2F1',
        body: {
          triggerMode: 'mention',
          memoryScope: 'conversation',
        },
      },
      {
        method: 'DELETE',
        url: '/v1/agents/agent%2F1/channel-bindings/conversation%2F1',
        body: null,
      },
    ]);
  });
});
