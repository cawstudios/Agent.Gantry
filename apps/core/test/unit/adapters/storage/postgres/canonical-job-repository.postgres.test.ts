import { describe, expect, it, vi } from 'vitest';

import { PostgresCanonicalJobRepository } from '@core/adapters/storage/postgres/repositories/canonical-job-repository.postgres.js';

function makeInsertOnlyDb() {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(async () => undefined),
      })),
    })),
  };
}

describe('PostgresCanonicalJobRepository', () => {
  it('ensures job agents without overwriting the canonical agent display name', async () => {
    const db = makeInsertOnlyDb();
    const repository = new PostgresCanonicalJobRepository(db as never);
    const graph = {
      ensureAgentExists: vi.fn(async () => 'agent:main_agent'),
      ensureAgent: vi.fn(),
    };
    (
      repository as unknown as {
        graph: typeof graph;
      }
    ).graph = graph;

    await repository.upsertJob({
      id: 'system:dreaming:main_agent:tg-5759865942',
      agentId: 'agent:main_agent',
      name: 'Memory Dreaming (main_agent tg:5759865942)',
      prompt: 'Run memory dreaming',
      model: null,
      scheduleJson: JSON.stringify({ type: 'cron', value: '0 * * * *' }),
      status: 'active',
      executionMode: 'serialized',
      targetJson: JSON.stringify({
        executionContext: {
          conversationJid: 'tg:5759865942',
          threadId: null,
          groupScope: 'main_agent',
          sessionId: null,
        },
      }),
      silent: true,
      timeoutMs: 300000,
      maxRetries: 3,
      retryBackoffMs: 5000,
      nextRunAt: null,
      lastRunAt: null,
      leaseRunId: null,
      leaseExpiresAt: null,
      createdAt: '2026-05-09T00:00:00.000Z',
      updatedAt: '2026-05-09T00:00:00.000Z',
    });

    expect(graph.ensureAgentExists).toHaveBeenCalledWith(
      'main_agent',
      'main_agent',
    );
    expect(graph.ensureAgent).not.toHaveBeenCalled();
  });
});
