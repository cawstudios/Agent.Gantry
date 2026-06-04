import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ConversationId } from '@core/domain/conversation/conversation.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

// Regression for the watermark microsecond-truncation bug (spec §8 anti-dup):
// the per-conversation cursor must store the message's EXACT microsecond
// created_at. If it stores the millisecond-truncated Message.createdAt instead,
// the just-covered sub-millisecond message re-qualifies as "new" on the next
// getMessagesSince sweep, so it is re-extracted forever. This test inserts a
// message with a genuine microsecond created_at, proves getMessageCreatedAt
// returns it un-truncated, and proves the exact watermark yields NO re-read
// while the truncated watermark WRONGLY re-reads it.
maybeDescribe('watermark microsecond precision (anti re-extraction)', () => {
  let runtime: PostgresIntegrationRuntime;

  const APP_ID = 'app:watermark-us-test';
  const AGENT_ID = 'agent:boondi_support';
  const PROVIDER_ID = 'interakt';
  const PROVIDER_CONN_ID = 'conn:watermark-us-test';
  const CONV_ID = 'conversation:watermark-us:1';
  const MSG_ID = 'msg:watermark-us:1';

  // A genuine MICROSECOND timestamp. Postgres timestamptz keeps all 6 digits;
  // only the JS Date round-trip in Message.createdAt truncates it to .123 (ms).
  const MICROSECOND_AT = '2026-06-04 10:00:00.123456+00';
  // The millisecond-truncated form that the buggy watermark would have stored.
  const MILLISECOND_AT = '2026-06-04 10:00:00.123+00';

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'watermark_us',
    });

    const pool = runtime.service.pool;

    await pool.query(
      `INSERT INTO apps (id, slug, name, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [APP_ID, 'watermark-us-test', 'Watermark US Test'],
    );
    await pool.query(
      `INSERT INTO providers (id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID, 'Interakt'],
    );
    await pool.query(
      `INSERT INTO provider_connections (id, app_id, provider_id, label, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'test-conn', 'active', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_CONN_ID, APP_ID, PROVIDER_ID],
    );
    await pool.query(
      `INSERT INTO conversations (id, app_id, provider_connection_id, kind, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'dm', 'active', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [CONV_ID, APP_ID, PROVIDER_CONN_ID],
    );

    // Insert the message DIRECTLY so the microseconds survive in the column.
    // (saveMessage may round-trip through a JS Date and lose them.)
    await pool.query(
      `INSERT INTO messages (id, app_id, provider, provider_connection_id, conversation_id, thread_id, direction, trust, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'inbound', 'full', $6::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [MSG_ID, APP_ID, PROVIDER_ID, PROVIDER_CONN_ID, CONV_ID, MICROSECOND_AT],
    );
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('getMessageCreatedAt returns the full microsecond timestamp (not ms-truncated)', async () => {
    const exact = await runtime.repositories.messages.getMessageCreatedAt({
      conversationId: CONV_ID as ConversationId,
      messageId: MSG_ID,
    });
    expect(exact).not.toBeNull();
    // The defining assertion: microseconds are preserved, NOT truncated to ms.
    expect(exact).toContain('123456');
    // Sanity: it is genuinely sub-millisecond (would be impossible after a JS
    // Date round-trip, which would yield ...123 then drop the trailing 456).
    expect(exact).not.toBe(MILLISECOND_AT);
    expect(Date.parse(exact as string)).toBe(Date.parse(MILLISECOND_AT));
  });

  it('exact (microsecond) watermark → covered message is NOT re-read', async () => {
    const exact = await runtime.repositories.messages.getMessageCreatedAt({
      conversationId: CONV_ID as ConversationId,
      messageId: MSG_ID,
    });
    expect(exact).not.toBeNull();

    // Full production path: store the exact value as the cursor, then read it
    // back through the cursor repo (covered_through_at is mode:'string', so it
    // keeps the microseconds), exactly like the idle sweep / boundary extractor.
    await runtime.repositories.memoryExtractionCursor.upsertCursor({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
      conversationId: CONV_ID as never,
      threadId: null,
      coveredThroughAt: exact as string,
      coveredThroughMessageId: MSG_ID,
    });
    const cursor = await runtime.repositories.memoryExtractionCursor.getCursor({
      appId: APP_ID as never,
      agentId: AGENT_ID as never,
      conversationId: CONV_ID as never,
      threadId: null,
    });
    expect(cursor).not.toBeNull();
    expect(cursor!.coveredThroughAt).toContain('123456');

    const sinceExact = await runtime.repositories.messages.getMessagesSince({
      conversationId: CONV_ID as ConversationId,
      since: cursor!.coveredThroughAt,
      sinceId: cursor!.coveredThroughMessageId,
      limit: 80,
    });
    // The covered microsecond message must NOT come back as "new".
    expect(sinceExact.map((m) => m.id)).toEqual([]);
  });

  it('ms-truncated watermark WRONGLY re-reads the covered message (documents the bug)', async () => {
    // This is precisely what the old code stored (Message.createdAt, truncated
    // to ms). Because created_at (.123456) > since (.123000), the covered
    // message re-qualifies as new — the infinite re-extraction loop.
    const sinceTruncated = await runtime.repositories.messages.getMessagesSince(
      {
        conversationId: CONV_ID as ConversationId,
        since: MILLISECOND_AT,
        sinceId: MSG_ID,
        limit: 80,
      },
    );
    expect(sinceTruncated.map((m) => m.id)).toEqual([MSG_ID]);
  });
});
