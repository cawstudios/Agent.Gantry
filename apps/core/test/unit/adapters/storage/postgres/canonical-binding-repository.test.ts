import { describe, expect, it, vi } from 'vitest';

const testLogger = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: testLogger,
}));

import { makeAgentThreadQueueKey } from '@core/application/provider-conversations/thread-queue-key.js';
import {
  PostgresCanonicalGraphRepository,
  conversationIdForJid,
} from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import {
  PostgresCanonicalBindingRepository,
  bindingRowsToGroups,
  bindingRowToGroup,
  type CanonicalBindingRecord,
} from '@core/adapters/storage/postgres/repositories/canonical-binding-repository.postgres.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import type { ConversationRoute } from '@core/domain/types.js';

function bindingRecord(
  overrides: Partial<CanonicalBindingRecord> = {},
): CanonicalBindingRecord {
  const providerAccountId = 'provider-account:telegram';
  const chatJid = 'tg:100';
  return {
    id: `conversation-route:${chatJid}`,
    agentId: 'agent:main_agent',
    agentName: 'Main Agent',
    providerAccountId,
    conversationId: `conversation:${providerAccountId}:${chatJid}`,
    threadId: null,
    status: 'active',
    conversationKind: 'group',
    requiresTrigger: false,
    memorySubjectJson: JSON.stringify({
      kind: 'conversation',
      appId: 'default',
      conversationId: `conversation:${providerAccountId}:${chatJid}`,
      liveRoute: {},
    }),
    displayName: 'Main Telegram',
    createdAt: '2026-05-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('canonical binding repository route projection', () => {
  it.each([
    {
      row: bindingRecord({ id: 'conversation-route:' }),
      reason: 'missing_route_key',
    },
    {
      row: bindingRecord({
        id: 'conversation-route:tg:malformed',
        providerAccountId: ' ',
      }),
      reason: 'missing_provider_account_id',
    },
  ])('skips corrupt route rows and keeps valid routes', ({ row, reason }) => {
    const valid = bindingRecord();
    testLogger.warn.mockClear();

    expect(bindingRowsToGroups([row, valid])).toEqual({
      'tg:100': expect.objectContaining({
        providerAccountId: 'provider-account:telegram',
      }),
    });
    expect(testLogger.warn).toHaveBeenCalledWith(
      {
        event: 'conversation_route_row_skipped',
        rowId: row.id,
        reason,
      },
      'Skipped malformed conversation route row during load',
    );
  });

  it('keeps one preferred alias per queue identity without collapsing distinct identities', () => {
    const providerAccountId = 'provider-account:telegram';
    const fullyQualifiedRouteKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
      undefined,
      providerAccountId,
    );
    const otherAgentRouteKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:other_agent',
      undefined,
      providerAccountId,
    );
    const otherAccountRouteKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
      undefined,
      'provider-account:telegram-two',
    );
    const rows = [
      bindingRecord({ conversationId: 'sales_telegram' }),
      bindingRecord({
        id: `conversation-route:${makeAgentThreadQueueKey(
          'tg:100',
          'agent:main_agent',
        )}`,
      }),
      bindingRecord({
        id: `conversation-route:${fullyQualifiedRouteKey}`,
      }),
      bindingRecord({
        id: `conversation-route:${otherAgentRouteKey}`,
        agentId: 'agent:other_agent',
      }),
      bindingRecord({
        id: `conversation-route:${otherAccountRouteKey}`,
        providerAccountId: 'provider-account:telegram-two',
        conversationId: 'conversation:provider-account:telegram-two:tg:100',
      }),
    ];
    testLogger.warn.mockClear();

    const routes = bindingRowsToGroups(rows);

    expect(Object.keys(routes).sort()).toEqual(
      [fullyQualifiedRouteKey, otherAgentRouteKey, otherAccountRouteKey].sort(),
    );
    expect(routes[fullyQualifiedRouteKey]?.conversationId).toBe(
      `conversation:${providerAccountId}:tg:100`,
    );
    expect(testLogger.warn).toHaveBeenCalledTimes(2);
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'conversation_route_alias_dropped',
        droppedConversationId: 'sales_telegram',
        keptRouteIds: [`conversation-route:${fullyQualifiedRouteKey}`],
      }),
      'Dropped stale conversation route alias during load',
    );
  });

  it('uses updated time then route key as a total-order tie breaker', () => {
    const olderRouteKey = makeAgentThreadQueueKey('tg:100', 'main_agent');
    const newerRouteKey = makeAgentThreadQueueKey('tg:100', 'agent:main_agent');
    const newer = bindingRecord({
      id: `conversation-route:${newerRouteKey}`,
      updatedAt: '2026-05-08T00:00:00.000Z',
    });
    const older = bindingRecord({
      id: `conversation-route:${olderRouteKey}`,
      updatedAt: '2026-05-07T00:00:00.000Z',
    });

    expect(bindingRowsToGroups([older, newer])).toEqual({
      [newerRouteKey]: expect.any(Object),
    });

    const lexicographicWinner = [olderRouteKey, newerRouteKey].sort()[0]!;
    expect(
      bindingRowsToGroups([{ ...older, updatedAt: newer.updatedAt }, newer]),
    ).toEqual({
      [lexicographicWinner]: expect.any(Object),
    });
  });

  it('preserves thread routes outside whole-conversation alias dedup', () => {
    const providerAccountId = 'provider-account:telegram';
    const threadRouteKey = makeAgentThreadQueueKey(
      'tg:100',
      'agent:main_agent',
      'thread-1',
      providerAccountId,
    );

    expect(
      Object.keys(
        bindingRowsToGroups([
          bindingRecord(),
          bindingRecord({
            id: `conversation-route:${threadRouteKey}`,
            threadId: 'thread:provider-account:telegram:tg:100:thread-1',
          }),
        ]),
      ).sort(),
    ).toEqual(['tg:100', threadRouteKey].sort());
  });

  it('normalizes provider and agent ids while rejecting conflicting qualifiers', () => {
    const normalizedRouteKey = makeAgentThreadQueueKey(
      'tg:100',
      'main_agent',
      undefined,
      'provider-account:telegram',
    );
    const conflictingRouteKey = makeAgentThreadQueueKey(
      'tg:200',
      'agent:main_agent',
      undefined,
      'provider-account:other',
    );
    testLogger.warn.mockClear();

    const routes = bindingRowsToGroups([
      bindingRecord({
        id: `conversation-route:${normalizedRouteKey}`,
        agentId: ' main_agent ',
        providerAccountId: ' provider-account:telegram ',
      }),
      bindingRecord({
        id: `conversation-route:${conflictingRouteKey}`,
        conversationId: 'conversation:provider-account:telegram:tg:200',
      }),
    ]);

    expect(routes[normalizedRouteKey]).toMatchObject({
      folder: 'main_agent',
      providerAccountId: 'provider-account:telegram',
    });
    expect(routes).not.toHaveProperty(conflictingRouteKey);
    expect(testLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'conversation_route_row_conflicting_qualifiers',
        rowId: `conversation-route:${conflictingRouteKey}`,
      }),
      'Skipped conflicting conversation route row during load',
    );
  });

  it('retains a stored legacy conversation id and warns instead of throwing', () => {
    const routeKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:main_agent',
      undefined,
      'provider-account:slack',
    );
    testLogger.warn.mockClear();

    expect(
      bindingRowsToGroups([
        bindingRecord({
          id: `conversation-route:${routeKey}`,
          providerAccountId: 'provider-account:slack',
          conversationId: 'sales_slack',
        }),
      ])[routeKey]?.conversationId,
    ).toBe('sales_slack');
    expect(testLogger.warn).toHaveBeenCalledWith(
      {
        event: 'conversation_route_conversation_id_noncanonical',
        rowId: `conversation-route:${routeKey}`,
        storedConversationId: 'sales_slack',
        expectedCanonicalConversationId:
          'conversation:provider-account:slack:sl:C123',
      },
      'Loaded non-canonical conversation route conversation id',
    );
  });

  it('reconstructs agent-qualified binding ids as persisted route keys', () => {
    const routeKey = makeAgentThreadQueueKey('tg:100', 'agent:main_agent');
    const row = {
      id: `conversation-route:${routeKey}`,
      agentId: 'agent:main_agent',
      agentName: 'Main Agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:tg:100',
      threadId: null,
      status: 'active',
      conversationKind: 'group',
      requiresTrigger: false,
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:tg:100',
        liveRoute: {},
      }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)).toMatchObject({ jid: routeKey });
  });

  it('reconstructs registered groups from conversation install route metadata', () => {
    const row = {
      id: 'conversation-route:tg:100',
      agentId: 'agent:main_agent',
      agentName: 'Main Agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:tg:100',
      threadId: null,
      status: 'active',
      conversationKind: 'group',
      requiresTrigger: false,
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:tg:100',
        liveRoute: {},
      }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)).toEqual({
      jid: 'tg:100',
      group: {
        name: 'Main Telegram',
        folder: 'main_agent',
        agentId: 'agent:main_agent',
        conversationId: 'conversation:tg:100',
        providerAccountId: 'provider-account:telegram',
        trigger: '@Main Agent',
        added_at: '2026-05-06T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    expect(JSON.parse(row.memorySubjectJson)).not.toHaveProperty('group');
    expect(JSON.parse(row.memorySubjectJson)).not.toHaveProperty('jid');
  });

  it('uses the persisted route key instead of a provider-account conversation id', () => {
    const row = {
      id: 'conversation-route:sl:C123',
      agentId: 'agent:main_agent',
      agentName: 'Main Agent',
      providerAccountId: 'slack_default',
      conversationId: 'conversation:slack_default:sl:C123',
      threadId: null,
      status: 'active',
      conversationKind: 'group',
      requiresTrigger: true,
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:slack_default:sl:C123',
        liveRoute: {},
      }),
      displayName: 'Slack General',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)).toMatchObject({ jid: 'sl:C123' });
  });

  it('ignores non-route and disabled binding rows', () => {
    const baseRow = {
      id: 'conversation-route:tg:100',
      agentId: 'agent:main_agent',
      agentName: 'Main Agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:tg:100',
      threadId: null,
      status: 'active',
      conversationKind: 'group',
      requiresTrigger: false,
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:tg:100',
        liveRoute: {},
      }),
      displayName: 'Main Telegram',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(
      bindingRowToGroup({ ...baseRow, id: 'agent-binding:one' }),
    ).toBeUndefined();
    expect(
      bindingRowToGroup({ ...baseRow, status: 'disabled' }),
    ).toBeUndefined();
  });

  it('rehydrates thread-scoped binding rows from their persisted route key', () => {
    const routeKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:main_agent',
      '1700.1',
      'provider-account:slack',
    );
    const row = {
      id: `conversation-route:${routeKey}`,
      agentId: 'agent:main_agent',
      agentName: 'Main Agent',
      providerAccountId: 'provider-account:slack',
      conversationId: 'conversation:sl:C123',
      threadId: 'thread:sl:C123:1700.1',
      status: 'active',
      conversationKind: 'group',
      requiresTrigger: true,
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:sl:C123',
        liveRoute: {},
      }),
      displayName: 'Incident thread',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)).toMatchObject({
      jid: routeKey,
      group: {
        name: 'Incident thread',
        trigger: '@Main Agent',
      },
    });
  });

  it('uses a non-empty trigger fallback for always-on bindings without trigger patterns', () => {
    const row = {
      id: 'conversation-route:app:one',
      agentId: 'agent:main_agent',
      agentName: 'Main Agent',
      providerAccountId: 'provider-account:app',
      conversationId: 'conversation:app:one',
      threadId: null,
      status: 'active',
      conversationKind: 'group',
      requiresTrigger: false,
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:app:one',
        liveRoute: {},
      }),
      displayName: 'App Conversation',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)?.group).toMatchObject({
      folder: 'main_agent',
      trigger: '@Main Agent',
      requiresTrigger: false,
    });
  });

  it('restores persisted route agentConfig overrides', () => {
    const row = {
      id: 'conversation-route:sl:C123',
      agentId: 'agent:main_agent',
      agentName: 'Main Agent',
      providerAccountId: 'provider-account:slack',
      conversationId: 'conversation:sl:C123',
      threadId: null,
      status: 'active',
      conversationKind: 'group',
      requiresTrigger: true,
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:sl:C123',
        liveRoute: {
          agentConfig: {
            model: 'opus',
            thinking: { mode: 'enabled', effort: 'high' },
            timeout: 120000,
          },
        },
      }),
      displayName: 'Ops',
      createdAt: '2026-05-06T00:00:00.000Z',
    };

    expect(bindingRowToGroup(row)?.group.agentConfig).toEqual({
      model: 'opus',
      thinking: { mode: 'enabled', effort: 'high' },
      timeout: 120000,
    });
  });

  it('preserves direct and channel route kind for memory scope after restart', () => {
    const directRow = {
      id: 'conversation-route:tg:5759865942',
      agentId: 'agent:main_agent',
      agentName: 'Main Agent',
      providerAccountId: 'provider-account:telegram',
      conversationId: 'conversation:tg:5759865942',
      threadId: null,
      status: 'active',
      conversationKind: 'direct',
      requiresTrigger: false,
      memorySubjectJson: JSON.stringify({
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation:tg:5759865942',
        liveRoute: {},
      }),
      displayName: 'Main Agent',
      createdAt: '2026-05-06T00:00:00.000Z',
    };
    const channelRow = {
      ...directRow,
      id: 'conversation-route:tg:-1003986348737',
      conversationId: 'conversation:tg:-1003986348737',
      conversationKind: 'group',
      displayName: 'Main Agent Telegram Group',
    };

    expect(bindingRowToGroup(directRow)?.group.conversationKind).toBe('dm');
    expect(bindingRowToGroup(channelRow)?.group.conversationKind).toBe(
      'channel',
    );
  });

  it('normalizes route keys to bare JIDs before ensuring conversations', async () => {
    const routeKey = makeAgentThreadQueueKey('tg:100', 'agent:main_agent');
    const insertedRows: unknown[] = [];
    const tx = {
      insert: vi.fn(() => ({
        values: (value: unknown) => {
          insertedRows.push(value);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        },
      })),
    } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const ensureConversation = vi.fn(
      async (jid: string) => `conversation:${jid}`,
    );
    const ensureAgent = vi.fn(async () => 'agent:main_agent');
    const getConversationInstallationId = vi.fn(
      async () => 'provider-account:default:tg',
    );

    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation,
      ensureAgent,
      getConversationInstallationId,
    };

    await repo.saveConversationRoute(routeKey, {
      name: 'Main',
      folder: 'main_agent',
      conversationId: 'configured:shared',
      trigger: '@main',
      added_at: '2026-06-01T00:00:00.000Z',
      requiresTrigger: true,
      conversationKind: 'channel',
      providerAccountId: 'provider-account:default:tg',
    } as ConversationRoute);

    expect(ensureConversation).toHaveBeenCalledOnce();
    expect(ensureConversation).toHaveBeenCalledWith(
      'tg:100',
      expect.objectContaining({
        existingConversationId: 'configured:shared',
        isGroup: true,
        providerAccountId: 'provider-account:default:tg',
      }),
      tx,
    );
    expect(ensureConversation).not.toHaveBeenCalledWith(
      'tg:100::agent:agent%3Amain_agent',
      expect.anything(),
      tx,
    );
    expect(ensureAgent).toHaveBeenCalledWith('main_agent', 'Main', tx);
    expect(insertedRows).toHaveLength(1);
    expect(
      insertedRows[0] as { id: string; conversationId: string },
    ).toMatchObject({
      id: `conversation-route:${routeKey}`,
      conversationId: 'conversation:tg:100',
    });
    expect(
      JSON.parse(
        (insertedRows[0] as { memorySubjectJson: string }).memorySubjectJson,
      ).liveRoute.conversationId,
    ).toBe('conversation:tg:100');
  });

  it('infers an omitted provider account from the stored legacy conversation', async () => {
    const insertedRows: Array<Record<string, unknown>> = [];
    const tx = {
      insert: vi.fn(() => ({
        values: (value: Record<string, unknown>) => {
          insertedRows.push(value);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        },
      })),
    } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const repo = new PostgresCanonicalBindingRepository(db);
    const getConversationInstallationId = vi.fn(
      async () => 'provider-account:slack',
    );
    (repo as any).graph = {
      ensureConversation: vi.fn(async () => 'sales_slack'),
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId,
    };

    await repo.saveConversationRoute(
      makeAgentThreadQueueKey('sl:C123', 'main_agent'),
      {
        name: 'Sales',
        folder: 'main_agent',
        conversationId: 'sales_slack',
        trigger: '@main',
        added_at: '2026-06-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
      },
    );

    expect(getConversationInstallationId).toHaveBeenNthCalledWith(
      1,
      'sales_slack',
      tx,
    );
    expect(insertedRows[0]).toMatchObject({
      providerAccountId: 'provider-account:slack',
      conversationId: 'sales_slack',
    });
    expect(
      JSON.parse(insertedRows[0]!.memorySubjectJson as string).liveRoute
        .conversationId,
    ).toBe('sales_slack');
  });

  it('uses a route-key provider qualifier when the route omits it', async () => {
    const insertedRows: Array<Record<string, unknown>> = [];
    const tx = {
      insert: vi.fn(() => ({
        values: (value: Record<string, unknown>) => {
          insertedRows.push(value);
          return { onConflictDoUpdate: vi.fn(async () => undefined) };
        },
      })),
    } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation: vi.fn(
        async () => 'conversation:provider-account:slack:sl:C123',
      ),
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(
        async () => 'provider-account:slack',
      ),
    };

    await repo.saveConversationRoute(
      makeAgentThreadQueueKey(
        'sl:C123',
        'agent:main_agent',
        undefined,
        'provider-account:slack',
      ),
      {
        name: 'Sales',
        folder: 'main_agent',
        trigger: '@main',
        added_at: '2026-06-01T00:00:00.000Z',
        requiresTrigger: true,
        conversationKind: 'channel',
      },
    );

    expect(insertedRows[0]).toMatchObject({
      providerAccountId: 'provider-account:slack',
    });
  });

  it('fails loudly for missing or contradictory route qualifiers', async () => {
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(async () => undefined),
        })),
      })),
    } as any;
    const db = {
      transaction: vi.fn(async (callback: any) => callback(tx)),
    } as any;
    const repo = new PostgresCanonicalBindingRepository(db);
    const graph = {
      ensureConversation: vi.fn(async () => 'conversation:sl:C123'),
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(async () => undefined),
    };
    (repo as any).graph = graph;
    const route = {
      name: 'Sales',
      folder: 'main_agent',
      trigger: '@main',
      added_at: '2026-06-01T00:00:00.000Z',
      requiresTrigger: true,
      conversationKind: 'channel' as const,
    };

    await expect(repo.saveConversationRoute('sl:C123', route)).rejects.toThrow(
      'Cannot persist conversation route sl:C123 without providerAccountId',
    );
    await expect(
      repo.saveConversationRoute(
        makeAgentThreadQueueKey(
          'sl:C123',
          'agent:main_agent',
          undefined,
          'provider-account:one',
        ),
        { ...route, providerAccountId: 'provider-account:two' },
      ),
    ).rejects.toThrow(
      'provider account qualifier provider-account:one does not match requested provider account provider-account:two',
    );
    await expect(
      repo.saveConversationRoute(
        makeAgentThreadQueueKey(
          'sl:C123',
          'agent:other_agent',
          undefined,
          'provider-account:one',
        ),
        route,
      ),
    ).rejects.toThrow(
      'agent qualifier agent:other_agent does not match resolved agent agent:main_agent',
    );
  });

  it('rejects a route-key account that conflicts with the installed account', async () => {
    const db = {
      transaction: vi.fn(async (callback: any) => callback({})),
    } as any;
    const repo = new PostgresCanonicalBindingRepository(db);
    (repo as any).graph = {
      ensureConversation: vi.fn(async () => 'sales_slack'),
      ensureAgent: vi.fn(async () => 'agent:main_agent'),
      getConversationInstallationId: vi.fn(
        async () => 'provider-account:installed',
      ),
    };

    await expect(
      repo.saveConversationRoute(
        makeAgentThreadQueueKey(
          'sl:C123',
          'agent:main_agent',
          undefined,
          'provider-account:key',
        ),
        {
          name: 'Sales',
          folder: 'main_agent',
          conversationId: 'sales_slack',
          trigger: '@main',
          added_at: '2026-06-01T00:00:00.000Z',
          requiresTrigger: true,
          conversationKind: 'channel',
        },
      ),
    ).rejects.toThrow(
      'resolved provider account provider-account:installed, expected provider-account:key',
    );
  });

  it('validates an existing conversation id before reusing it', async () => {
    const providerAccountId = 'provider-account:slack';
    const existingRow = {
      appId: 'default',
      providerAccountId,
      externalRefJson: JSON.stringify({ jid: 'sl:C123' }),
    };
    const makeGraph = (conversationRows: Array<Record<string, unknown>>) => {
      let query: any;
      query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(async () => conversationRows),
      };
      const insertedRows: Array<Record<string, unknown>> = [];
      const db = {
        select: vi.fn(() => query),
        insert: vi.fn(() => ({
          values: (value: Record<string, unknown>) => {
            insertedRows.push(value);
            return {
              onConflictDoNothing: vi.fn(async () => undefined),
              onConflictDoUpdate: vi.fn(async () => undefined),
            };
          },
        })),
      } as any;
      return {
        graph: new PostgresCanonicalGraphRepository(db),
        insertedRows,
      };
    };

    const matching = makeGraph([existingRow]);
    await expect(
      matching.graph.ensureConversation('sl:C123', {
        providerAccountId,
        existingConversationId: 'sales_slack',
      }),
    ).resolves.toBe('sales_slack');

    const missing = makeGraph([]);
    await expect(
      missing.graph.ensureConversation('sl:C123', {
        providerAccountId,
        existingConversationId: 'sales_settings_key',
      }),
    ).resolves.toBe(conversationIdForJid('sl:C123', providerAccountId));
    expect(missing.insertedRows.at(-1)).toMatchObject({
      id: conversationIdForJid('sl:C123', providerAccountId),
    });

    const mismatched = makeGraph([
      {
        ...existingRow,
        externalRefJson: JSON.stringify({ jid: 'sl:C999' }),
      },
    ]);
    await expect(
      mismatched.graph.ensureConversation('sl:C123', {
        providerAccountId,
        existingConversationId: 'sales_settings_key',
      }),
    ).rejects.toThrow(
      'Existing conversation sales_settings_key does not match route sl:C123',
    );
  });

  it('requires active provider accounts when loading active route rows', async () => {
    let query: any;
    query = {
      from: vi.fn(() => query),
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(async () => []),
    };
    const db = {
      select: vi.fn(() => query),
    } as any;

    const repo = new PostgresCanonicalBindingRepository(db);
    await repo.listConversationRoutes();

    expect(query.innerJoin).toHaveBeenCalledWith(
      pgSchema.providerAccountsPostgres,
      expect.anything(),
    );
    expect(query.innerJoin).toHaveBeenCalledWith(
      pgSchema.agentsPostgres,
      expect.anything(),
    );
  });
});
