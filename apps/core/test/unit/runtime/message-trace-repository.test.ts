import { describe, expect, it, vi } from 'vitest';
import { PostgresMessageTraceRepository } from '@core/adapters/storage/postgres/repositories/message-trace-repository.postgres.js';

const row = {
  messageId: 'message:jid:m1',
  appId: 'a',
  conversationId: 'c',
  kind: 'reply' as const,
  totalMs: 5,
  timingsJson: { version: 1 as const, totalMs: 5, stages: [] },
  payloadsJson: null,
  createdAt: '2026-06-14T00:00:00.000Z',
};

describe('PostgresMessageTraceRepository', () => {
  it('inserts a trace row via onConflictDoNothing', async () => {
    const captured: unknown[] = [];
    const fakeDb = {
      insert: () => ({
        values: (v: unknown) => ({
          onConflictDoNothing: async () => {
            captured.push(v);
          },
        }),
      }),
    };
    const repo = new PostgresMessageTraceRepository(fakeDb as never);
    await repo.save(row);
    expect((captured[0] as { messageId: string }).messageId).toBe(
      'message:jid:m1',
    );
  });

  it('never throws into the reply path on a db error', async () => {
    const warn = vi.fn();
    const throwingDb = {
      insert: () => {
        throw new Error('db down');
      },
    };
    const repo = new PostgresMessageTraceRepository(throwingDb as never, {
      warn,
    });
    await expect(repo.save(row)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never throws when onConflictDoNothing rejects', async () => {
    const rejectingDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => {
            throw new Error('constraint exploded');
          },
        }),
      }),
    };
    const repo = new PostgresMessageTraceRepository(rejectingDb as never);
    await expect(repo.save(row)).resolves.toBeUndefined();
  });

  it('redacts high-risk secret fields before storing payload traces', async () => {
    const captured: unknown[] = [];
    const fakeDb = {
      insert: () => ({
        values: (v: unknown) => ({
          onConflictDoNothing: async () => {
            captured.push(v);
          },
        }),
      }),
    };
    const repo = new PostgresMessageTraceRepository(fakeDb as never);

    await repo.save({
      ...row,
      payloadsJson: {
        0: {
          request: {
            authorization: 'Bearer secret-token',
            apiKey: 'sk-live-secret',
            safe: 'keep-me',
            nested: { signing_secret: 'hmac-secret' },
          },
        },
      },
    });

    expect(captured[0]).toMatchObject({
      payloadsJson: {
        0: {
          request: {
            authorization: '[REDACTED]',
            apiKey: '[REDACTED]',
            safe: 'keep-me',
            nested: { signing_secret: '[REDACTED]' },
          },
        },
      },
    });
  });

  it('replaces oversized payload traces with a bounded truncation marker', async () => {
    const captured: unknown[] = [];
    const fakeDb = {
      insert: () => ({
        values: (v: unknown) => ({
          onConflictDoNothing: async () => {
            captured.push(v);
          },
        }),
      }),
    };
    const repo = new PostgresMessageTraceRepository(
      fakeDb as never,
      undefined,
      {
        payloadMaxBytes: 64,
      },
    );

    await repo.save({
      ...row,
      payloadsJson: {
        0: {
          request: 'x'.repeat(500),
        },
      },
    });

    expect(captured[0]).toMatchObject({
      payloadsJson: {
        __gantryPayloadPolicy: {
          truncated: true,
          reason: 'payload_byte_limit_exceeded',
          maxBytes: 64,
        },
      },
    });
  });

  it('reads payload traces by app and message id', async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                messageId: 'message:jid:m1',
                appId: 'a',
                conversationId: 'c',
                payloadsJson: { 0: { response: { ok: true } } },
                createdAt: '2026-06-14T00:00:00.000Z',
              },
            ],
          }),
        }),
      }),
    };
    const repo = new PostgresMessageTraceRepository(fakeDb as never);

    await expect(
      repo.readPayloads({ appId: 'a', messageId: 'message:jid:m1' }),
    ).resolves.toEqual({
      messageId: 'message:jid:m1',
      appId: 'a',
      conversationId: 'c',
      payloadsJson: { 0: { response: { ok: true } } },
      createdAt: '2026-06-14T00:00:00.000Z',
    });
  });

  it('clears old payload traces for retention without deleting timings', async () => {
    const returning = vi.fn(async () => [
      { messageId: 'message:jid:old-1' },
      { messageId: 'message:jid:old-2' },
    ]);
    const set = vi.fn(() => ({ where: () => ({ returning }) }));
    const fakeDb = {
      update: () => ({ set }),
    };
    const repo = new PostgresMessageTraceRepository(fakeDb as never);

    await expect(
      repo.clearPayloadsOlderThan({
        appId: 'a',
        before: '2026-06-15T00:00:00.000Z',
      }),
    ).resolves.toBe(2);
    expect(set).toHaveBeenCalledWith({ payloadsJson: null });
  });
});
