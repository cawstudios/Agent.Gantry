import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresMemoryExtractionCursorRepository } from '@core/adapters/storage/postgres/repositories/memory-extraction-cursor-repository.postgres.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('memory_extraction_cursor repository', () => {
  let runtime: PostgresIntegrationRuntime;
  let repo: PostgresMemoryExtractionCursorRepository;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({ schemaPrefix: 'mec' });
    repo = new PostgresMemoryExtractionCursorRepository(runtime.service.db);
  }, 60_000);
  afterAll(async () => {
    await runtime.cleanup();
  });

  const scope = {
    appId: 'default' as never,
    agentId: 'agent:boondi_support' as never,
    conversationId: 'conversation:wa:7000000001' as never,
    threadId: null,
  };

  it('returns null before any cursor exists', async () => {
    expect(await repo.getCursor(scope)).toBeNull();
  });

  it('upserts and reads back, then advances on second upsert', async () => {
    await repo.upsertCursor({
      ...scope,
      coveredThroughAt: '2026-06-04T10:00:00.000Z',
      coveredThroughMessageId: 'm1',
    });
    const first = await repo.getCursor(scope);
    expect(first).not.toBeNull();
    expect(first!.coveredThroughMessageId).toBe('m1');
    expect(new Date(first!.coveredThroughAt).toISOString()).toBe(
      '2026-06-04T10:00:00.000Z',
    );

    await repo.upsertCursor({
      ...scope,
      coveredThroughAt: '2026-06-04T11:00:00.000Z',
      coveredThroughMessageId: 'm5',
    });
    const second = await repo.getCursor(scope);
    expect(second).not.toBeNull();
    expect(second!.coveredThroughMessageId).toBe('m5');
    expect(new Date(second!.coveredThroughAt).toISOString()).toBe(
      '2026-06-04T11:00:00.000Z',
    );
  });

  it('isolates cursors by threadId (surrogate-key arm)', async () => {
    const threaded = {
      appId: 'default' as never,
      agentId: 'agent:boondi_support' as never,
      conversationId: 'conversation:wa:7000000002' as never,
      threadId: 'thread-a' as never,
    };
    const nullThread = { ...threaded, threadId: null };

    await repo.upsertCursor({
      ...threaded,
      coveredThroughAt: '2026-06-04T12:00:00.000Z',
      coveredThroughMessageId: 'tA',
    });
    // Same conversation but null thread must be a DISTINCT row (not yet written).
    expect(await repo.getCursor(nullThread)).toBeNull();

    await repo.upsertCursor({
      ...nullThread,
      coveredThroughAt: '2026-06-04T12:30:00.000Z',
      coveredThroughMessageId: 'tN',
    });
    const threadedRow = await repo.getCursor(threaded);
    const nullRow = await repo.getCursor(nullThread);
    expect(threadedRow!.coveredThroughMessageId).toBe('tA');
    expect(nullRow!.coveredThroughMessageId).toBe('tN');
  });
});
