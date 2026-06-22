import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePool, makeFakeRepo, stubLlm } from './helpers/fakes.js';
import {
  createConversationBackoff,
  runDigestCycleOnce,
  runManualConversationExtraction,
  startDigestWatcher,
} from '../src/watcher/index.js';
import {
  advanceDigestCursor,
  pendingDigestsSql,
} from '../src/watcher/digest-source.js';

const env = {
  gantrySchema: 'gantry',
  reconcileAgentId: 'agent:boondi_support',
  crmLeadQueryExtractionWatcher: {
    enabled: true,
    pollIntervalMs: 1,
    model: 'x',
    maxParallelExtractions: 1,
    batchSize: 25,
    dbPoolSize: 5,
  },
  anthropicApiKey: 'x',
} as any;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
} as any;

const llm = stubLlm(
  '{"opportunities":[{"match":null,"isLead":true,"occasion":"Diwali","quantity":200,"summaryBrief":"200 Diwali","evidenceQuote":"200 boxes","confidence":0.9}]}',
);

describe('runDigestCycleOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds filter placeholders from SQL params, not predicate count', () => {
    const sql = pendingDigestsSql('gantry', {
      conversationId: 'conversation:wa:919654405340',
      since: '2026-06-08T20:00:00.000Z',
      limit: 1,
    });
    expect(sql).toContain('s.agent_id = $1');
    expect(sql).toContain('s.conversation_id = $2');
    expect(sql).toContain('d.created_at >= $3::timestamptz');
    expect(sql).toContain('LIMIT $4');
  });

  it('extracts from a new digest, upserts, and advances the cursor', async () => {
    const { pool, query } = makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) {
        return {
          rows: [
            {
              digest_id: 'd1',
              conversation_id: 'conversation:wa:9001',
              digest: 'digest text',
              created_at: '2026-06-06T00:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('message_parts')) {
        return {
          rows: [{ direction: 'inbound', text: 'I want 200 boxes for Diwali' }],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo();
    const stats = await runDigestCycleOnce({ env, logger, pool, repo, llm });
    expect(stats.digests).toBe(1);
    expect(stats.created).toBe(1);
    expect(repo.upsertOpportunity).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ digests: 1 }),
      'digest_cycle_started',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ digestId: 'd1', transcriptMessages: 1 }),
      'digest_process_started',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        digestId: 'd1',
        extracted: 1,
        created: 1,
        output: [
          expect.objectContaining({ action: 'created', status: 'lead' }),
        ],
      }),
      'digest_process_completed',
    );
    const advanced = query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO boondi_digest_cursor'),
    );
    expect(advanced).toBe(true);
  });

  it('supports a filtered, read-only dry run of the digest cycle', async () => {
    const complete = vi.fn(
      async () =>
        '{"opportunities":[{"match":null,"isLead":true,"summaryBrief":"200 Diwali","evidenceQuote":"200 boxes","confidence":0.9}]}',
    );
    const { pool, query } = makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) {
        return {
          rows: [
            {
              digest_id: 'd1',
              conversation_id: 'conversation:wa:919654405340',
              digest: 'digest text',
              created_at: '2026-06-06T00:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('message_parts')) {
        return {
          rows: [{ direction: 'inbound', text: 'I want 200 boxes for Diwali' }],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo();

    const stats = await runDigestCycleOnce(
      { env, logger, pool, repo, llm: { complete } },
      {
        apply: false,
        conversationId: 'conversation:wa:919654405340',
        since: '2026-06-08T20:00:00.000Z',
        limit: 1,
      },
    );

    expect(stats).toMatchObject({
      digests: 1,
      extracted: 1,
      created: 0,
      updated: 0,
    });
    expect(query.mock.calls[0][1]).toEqual([
      env.reconcileAgentId,
      'conversation:wa:919654405340',
      '2026-06-08T20:00:00.000Z',
      1,
    ]);
    expect(repo.upsertOpportunity).not.toHaveBeenCalled();
    const advanced = query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO boondi_digest_cursor'),
    );
    expect(advanced).toBe(false);
  });

  it('excludes manual command messages and their assistant acknowledgements from extraction', async () => {
    const complete = vi.fn(async () => '{"opportunities":[]}');
    const { pool } = makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) {
        return {
          rows: [
            {
              digest_id: 'd1',
              conversation_id: 'conversation:wa:9001',
              digest: 'digest text',
              created_at: '2026-06-06T00:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('message_parts')) {
        return {
          rows: [
            { direction: 'inbound', text: '/digest-session' },
            { direction: 'outbound', text: 'Digest session queued.' },
            { direction: 'inbound', text: '/extract-leads-queries' },
            { direction: 'outbound', text: 'Lead extraction complete.' },
            { direction: 'inbound', text: 'I want 200 boxes for Diwali' },
            { direction: 'outbound', text: 'Sure, sharing options.' },
          ],
        };
      }
      return { rows: [] };
    });

    await runDigestCycleOnce({
      env,
      logger,
      pool,
      repo: makeFakeRepo(),
      llm: { complete },
    });

    const prompt = complete.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('customer: I want 200 boxes for Diwali');
    expect(prompt).toContain('assistant: Sure, sharing options.');
    expect(prompt).not.toContain('/digest-session');
    expect(prompt).not.toContain('Digest session queued.');
    expect(prompt).not.toContain('/extract-leads-queries');
    expect(prompt).not.toContain('Lead extraction complete.');
  });

  it('is a no-op when no digests are pending', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }));
    const repo = makeFakeRepo();
    const stats = await runDigestCycleOnce({ env, logger, pool, repo, llm });
    expect(stats.digests).toBe(0);
    expect(repo.upsertOpportunity).not.toHaveBeenCalled();
  });

  it('returns zeros when the llm is disabled (null)', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }));
    const repo = makeFakeRepo();
    const stats = await runDigestCycleOnce({
      env,
      logger,
      pool,
      repo,
      llm: null,
    });
    expect(stats.digests).toBe(0);
  });
});

describe('runManualConversationExtraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the same digest cycle as the automatic watcher for one conversation', async () => {
    const { pool, query } = makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) {
        return {
          rows: [
            {
              digest_id: 'd_manual',
              conversation_id: 'conversation:wa:919654405340',
              digest: 'manual digest text',
              created_at: '2026-06-06T00:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('message_parts')) {
        return {
          rows: [{ direction: 'inbound', text: 'I want 200 boxes for Diwali' }],
        };
      }
      return { rows: [] };
    });
    const repo = makeFakeRepo();

    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm },
      'conversation:wa:919654405340',
    );

    expect(stats).toEqual({
      digests: 1,
      extracted: 1,
      created: 1,
      updated: 0,
      skipped: 0,
    });
    expect(query.mock.calls[0][1]).toEqual([
      env.reconcileAgentId,
      'conversation:wa:919654405340',
      25,
    ]);
    expect(repo.upsertOpportunity).toHaveBeenCalledTimes(1);
    const advanced = query.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO boondi_digest_cursor'),
    );
    expect(advanced).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        digests: 1,
        trigger: 'manual',
        apply: true,
      }),
      'digest_cycle_started',
    );
  });

  it('rejects a non-WhatsApp conversation id', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }));
    await expect(
      runManualConversationExtraction(
        { env, logger, pool, repo: makeFakeRepo(), llm },
        'conversation:slack:C123',
      ),
    ).rejects.toThrow(/conversation:wa:<digits>/);
  });

  it('is a no-op when no pending digest exists', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }));
    const repo = makeFakeRepo();
    const complete = vi.fn(async () => '{"opportunities":[]}');

    const stats = await runManualConversationExtraction(
      { env, logger, pool, repo, llm: { complete } },
      'conversation:wa:919654405340',
    );

    expect(stats).toEqual({
      digests: 0,
      extracted: 0,
      created: 0,
      updated: 0,
      skipped: 0,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(repo.upsertOpportunity).not.toHaveBeenCalled();
  });
});

describe('startDigestWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the timer without running a digest cycle immediately', async () => {
    const { pool, query } = makeFakePool(() => ({ rows: [] }));
    const stop = startDigestWatcher({
      env,
      logger,
      pool,
      repo: makeFakeRepo(),
      llm,
    });

    expect(query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(env.crmLeadQueryExtractionWatcher.pollIntervalMs);

    expect(query).toHaveBeenCalled();
    stop();
  });
});

describe('digest bookmark — stop at first gap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Pool seeded with a fixed set of pending digests + a one-line transcript.
  const poolWithDigests = (rows: any[]) =>
    makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) return { rows };
      if (sql.includes('message_parts')) {
        return {
          rows: [{ direction: 'inbound', text: 'I want 200 boxes for Diwali' }],
        };
      }
      return { rows: [] };
    });

  const cursorAdvances = (query: any): any[] =>
    query.mock.calls.filter((call: any[]) =>
      String(call[0]).includes('INSERT INTO boondi_digest_cursor'),
    );

  it('stops at a soft-failed digest and does not process or advance past it', async () => {
    // Two pending digests for ONE conversation, oldest first. The older one
    // parse-fails, so the newer one must NOT be processed and the cursor must NOT
    // advance past the gap — the failed digest stays eligible for next cycle.
    const { pool, query } = poolWithDigests([
      {
        digest_id: 'd1',
        conversation_id: 'conversation:wa:9001',
        digest: 'older',
        created_at: '2026-06-06T00:00:00Z',
      },
      {
        digest_id: 'd2',
        conversation_id: 'conversation:wa:9001',
        digest: 'newer',
        created_at: '2026-06-07T00:00:00Z',
      },
    ]);
    const complete = vi.fn(async () => 'PARSE FAIL — not json');

    const stats = await runDigestCycleOnce({
      env,
      logger,
      pool,
      repo: makeFakeRepo(),
      llm: { complete },
    });

    expect(complete).toHaveBeenCalledTimes(1); // d2 was never reached
    expect(cursorAdvances(query)).toHaveLength(0); // gap → cursor not advanced
    expect(stats.skipped).toBe(1);
    expect(stats.created).toBe(0);
  });

  it('drains a conversation oldest-first, advancing the cursor per success', async () => {
    const { pool, query } = poolWithDigests([
      {
        digest_id: 'd1',
        conversation_id: 'conversation:wa:9001',
        digest: 'older',
        created_at: '2026-06-06T00:00:00Z',
      },
      {
        digest_id: 'd2',
        conversation_id: 'conversation:wa:9001',
        digest: 'newer',
        created_at: '2026-06-07T00:00:00Z',
      },
    ]);

    const stats = await runDigestCycleOnce({
      env,
      logger,
      pool,
      repo: makeFakeRepo(),
      llm,
    });

    expect(stats.created).toBe(2);
    const advances = cursorAdvances(query);
    expect(advances).toHaveLength(2);
    // Params are [conversationId, digestId, digestAt] — oldest (d1) then newest (d2).
    expect(advances[0][1]).toEqual([
      'conversation:wa:9001',
      'd1',
      '2026-06-06T00:00:00Z',
    ]);
    expect(advances[1][1]).toEqual([
      'conversation:wa:9001',
      'd2',
      '2026-06-07T00:00:00Z',
    ]);
  });

  it('a soft fail in one conversation does not block another conversation', async () => {
    // A (older, conv 9001) parse-fails; B (newer, conv 9002) still processes and
    // advances — distinct conversations have independent cursors.
    const { pool, query } = poolWithDigests([
      {
        digest_id: 'a1',
        conversation_id: 'conversation:wa:9001',
        digest: 'A',
        created_at: '2026-06-06T00:00:00Z',
      },
      {
        digest_id: 'b1',
        conversation_id: 'conversation:wa:9002',
        digest: 'B',
        created_at: '2026-06-07T00:00:00Z',
      },
    ]);
    let call = 0;
    const complete = vi.fn(async () => {
      call += 1;
      return call === 1
        ? 'PARSE FAIL'
        : '{"opportunities":[{"match":null,"isLead":true,"summaryBrief":"x","evidenceQuote":"y","confidence":0.9}]}';
    });

    const stats = await runDigestCycleOnce({
      env,
      logger,
      pool,
      repo: makeFakeRepo(),
      llm: { complete },
    });

    expect(complete).toHaveBeenCalledTimes(2);
    const advances = cursorAdvances(query);
    expect(advances).toHaveLength(1);
    expect(advances[0][1][0]).toBe('conversation:wa:9002'); // only B advanced
    expect(stats.skipped).toBe(1);
    expect(stats.created).toBe(1);
  });
});

describe('digest watcher — parallel extraction + back-off', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const poolFor = (rows: any[]) =>
    makeFakePool((sql) => {
      if (sql.includes('agent_session_digests')) return { rows };
      if (sql.includes('message_parts')) {
        return { rows: [{ direction: 'inbound', text: 'I want 200 boxes' }] };
      }
      return { rows: [] };
    });

  const envWith = (overrides: Record<string, unknown>) => ({
    ...env,
    crmLeadQueryExtractionWatcher: {
      ...env.crmLeadQueryExtractionWatcher,
      ...overrides,
    },
  });

  it('extracts DISTINCT customers in parallel, bounded by max_parallel_extractions', async () => {
    // 3 distinct conversations, 1 digest each; cap = 2 → peak concurrency must be 2.
    const { pool } = poolFor([
      { digest_id: 'a', conversation_id: 'conversation:wa:9001', digest: 'a', created_at: '2026-06-06T00:00:00Z' },
      { digest_id: 'b', conversation_id: 'conversation:wa:9002', digest: 'b', created_at: '2026-06-06T00:00:01Z' },
      { digest_id: 'c', conversation_id: 'conversation:wa:9003', digest: 'c', created_at: '2026-06-06T00:00:02Z' },
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveGate: () => void = () => undefined;
    const gate = new Promise<void>((r) => (resolveGate = r));
    const complete = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight >= 2) resolveGate();
      // Fallback so a NON-parallel (cap=1) run doesn't hang the test — it just
      // proceeds serially and maxInFlight stays 1, failing the assertion.
      await Promise.race([gate, new Promise((r) => setTimeout(r, 300))]);
      inFlight -= 1;
      return '{"opportunities":[]}';
    });

    await runDigestCycleOnce({
      env: envWith({ maxParallelExtractions: 2 }),
      logger,
      pool,
      repo: makeFakeRepo(),
      llm: { complete },
    });

    expect(complete).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(2); // bounded: 2 concurrent, never 3
  });

  it('backs off a repeatedly soft-failing conversation instead of retrying every cycle', async () => {
    const rows = [
      { digest_id: 'a', conversation_id: 'conversation:wa:9001', digest: 'a', created_at: '2026-06-06T00:00:00Z' },
    ];
    const complete = vi.fn(async () => 'PARSE FAIL'); // always soft-fails
    const backoff = createConversationBackoff();
    const deps = (now: number) => ({
      env: envWith({ maxParallelExtractions: 1 }),
      logger,
      pool: poolFor(rows).pool,
      repo: makeFakeRepo(),
      llm: { complete },
    });

    // Cycle at t=0 → fails, records back-off (~60s window).
    await runDigestCycleOnce(deps(0), { backoff, now: () => 0 });
    expect(complete).toHaveBeenCalledTimes(1);
    // Cycle at t=1s → inside the window → skipped (not retried).
    await runDigestCycleOnce(deps(1000), { backoff, now: () => 1000 });
    expect(complete).toHaveBeenCalledTimes(1);
    // Cycle past the window (t=120s) → eligible again → retried.
    await runDigestCycleOnce(deps(120_000), { backoff, now: () => 120_000 });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('advanceDigestCursor (monotonic)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('advances forward-only via an ON CONFLICT guard (no blind overwrite)', async () => {
    const { pool, query } = makeFakePool(() => ({ rows: [] }));
    await advanceDigestCursor(
      pool as any,
      'conversation:wa:9001',
      'd1',
      '2026-06-06T00:00:00Z',
    );
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO boondi_digest_cursor');
    expect(String(sql)).toContain(
      'EXCLUDED.last_digest_at > boondi_digest_cursor.last_digest_at',
    );
    expect(params).toEqual([
      'conversation:wa:9001',
      'd1',
      '2026-06-06T00:00:00Z',
    ]);
  });
});
