import { and, asc, eq, like } from 'drizzle-orm';

import type { AgentId } from '../../../../domain/agent/agent.js';
import {
  agentIdForFolder,
  folderForAgentId,
} from '../../../../domain/agent/agent-folder-id.js';
import type { ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import { logger } from '../../../../infrastructure/logging/logger.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import { parseAgentThreadQueueKey } from '../../../../application/provider-conversations/thread-queue-key.js';
import { defaultTriggerForAgentName } from '../../../../shared/trigger-pattern.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  conversationIdForJid,
  json,
  parseJson,
  PostgresCanonicalGraphRepository,
} from './canonical-graph-repository.postgres.js';

export interface CanonicalBindingRecord {
  id: string;
  agentId: string;
  agentName: string;
  providerAccountId: string;
  conversationId: string;
  threadId: string | null;
  status: string;
  conversationKind: string;
  requiresTrigger: boolean;
  memorySubjectJson: string;
  displayName: string;
  createdAt: string;
  updatedAt?: string;
}

const CONVERSATION_ROUTE_BINDING_ID_PREFIX = 'conversation-route:';

export function conversationRouteKeyFromBindingRow(
  row: Pick<CanonicalBindingRecord, 'id'>,
): string | undefined {
  if (!row.id.startsWith(CONVERSATION_ROUTE_BINDING_ID_PREFIX)) {
    return undefined;
  }
  return row.id.slice(CONVERSATION_ROUTE_BINDING_ID_PREFIX.length) || undefined;
}

function routeBindingId(jid: string): string {
  return `${CONVERSATION_ROUTE_BINDING_ID_PREFIX}${jid}`;
}

export function normalizeRouteAgentId(agentId: string): string {
  return agentIdForFolder(folderForAgentId(agentId as AgentId) ?? agentId);
}

interface StoredLiveRouteProjection {
  kind: 'conversation';
  appId: string;
  conversationId: string;
  liveRoute?: {
    conversationId?: string;
    agentConfig?: ConversationRoute['agentConfig'];
  };
}

function storedLiveRouteProjection(
  conversationId: string,
  group: ConversationRoute,
): StoredLiveRouteProjection {
  return {
    kind: 'conversation',
    appId: CANONICAL_APP_ID,
    conversationId,
    liveRoute: {
      conversationId,
      ...(group.agentConfig ? { agentConfig: group.agentConfig } : {}),
    },
  };
}

export class PostgresCanonicalBindingRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async saveConversationRoute(
    jid: string,
    group: ConversationRoute,
  ): Promise<void> {
    const parsedRouteKey = parseAgentThreadQueueKey(jid);
    const { chatJid } = parsedRouteKey;
    const requestedProviderAccountId =
      group.providerAccountId?.trim() || undefined;
    const resolvedAgentId = normalizeRouteAgentId(group.folder);
    if (
      parsedRouteKey.agentId !== undefined &&
      normalizeRouteAgentId(parsedRouteKey.agentId) !== resolvedAgentId
    ) {
      throw new Error(
        `Conversation route ${jid} agent qualifier ${parsedRouteKey.agentId} does not match resolved agent ${resolvedAgentId}`,
      );
    }
    if (
      requestedProviderAccountId !== undefined &&
      parsedRouteKey.providerAccountId !== undefined &&
      parsedRouteKey.providerAccountId !== requestedProviderAccountId
    ) {
      throw new Error(
        `Conversation route ${jid} provider account qualifier ${parsedRouteKey.providerAccountId} does not match requested provider account ${requestedProviderAccountId}`,
      );
    }
    const preEnsureProviderAccountId =
      requestedProviderAccountId ?? parsedRouteKey.providerAccountId;
    await this.db.transaction(async (tx) => {
      const resolvedProviderAccountId =
        preEnsureProviderAccountId ??
        (group.conversationId
          ? (
              await this.graph.getConversationInstallationId(
                group.conversationId,
                tx,
              )
            )?.trim()
          : undefined);
      const conversationId = await this.graph.ensureConversation(
        chatJid,
        {
          name: group.name,
          agentFolder: group.folder,
          existingConversationId: group.conversationId,
          providerAccountId: resolvedProviderAccountId,
          isGroup:
            group.conversationKind === 'dm'
              ? false
              : group.conversationKind === 'channel'
                ? true
                : group.requiresTrigger !== false,
          requiresTrigger: group.requiresTrigger ?? true,
        },
        tx,
      );
      const agentId = await this.graph.ensureAgent(
        group.folder,
        group.name,
        tx,
      );
      const installationProviderAccountId = (
        await this.graph.getConversationInstallationId(conversationId, tx)
      )?.trim();
      const providerAccountId =
        resolvedProviderAccountId ?? installationProviderAccountId;
      if (!providerAccountId) {
        throw new Error(
          `Cannot persist conversation route ${jid} without providerAccountId`,
        );
      }
      if (
        installationProviderAccountId &&
        installationProviderAccountId !== providerAccountId
      ) {
        throw new Error(
          `Conversation route ${jid} resolved provider account ${installationProviderAccountId}, expected ${providerAccountId}`,
        );
      }
      // Existing legacy IDs remain authoritative until Phase 8 can restamp
      // their conversation, graph, and memory references transactionally.
      const now = group.added_at || currentIso();
      await tx
        .insert(pgSchema.conversationInstallsPostgres)
        .values({
          id: routeBindingId(jid),
          appId: CANONICAL_APP_ID,
          agentId,
          providerAccountId,
          conversationId,
          displayName: group.name,
          status: 'active',
          memoryScope: 'conversation',
          memorySubjectJson: json(
            storedLiveRouteProjection(conversationId, group),
          ),
          permissionPolicyIdsJson: '[]',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pgSchema.conversationInstallsPostgres.id,
          set: {
            agentId,
            providerAccountId,
            conversationId,
            displayName: group.name,
            status: 'active',
            memoryScope: 'conversation',
            memorySubjectJson: json(
              storedLiveRouteProjection(conversationId, group),
            ),
            updatedAt: now,
          },
        });
    });
  }

  async deleteConversationRoute(jid: string): Promise<void> {
    await this.db
      .delete(pgSchema.conversationInstallsPostgres)
      .where(eq(pgSchema.conversationInstallsPostgres.id, routeBindingId(jid)));
  }

  async listConversationRoutes(): Promise<CanonicalBindingRecord[]> {
    const b = pgSchema.conversationInstallsPostgres;
    const c = pgSchema.conversationsPostgres;
    const pa = pgSchema.providerAccountsPostgres;
    const a = pgSchema.agentsPostgres;
    return this.db
      .select({
        id: b.id,
        agentId: b.agentId,
        agentName: a.name,
        providerAccountId: b.providerAccountId,
        conversationId: b.conversationId,
        threadId: b.threadId,
        status: b.status,
        conversationKind: c.kind,
        requiresTrigger: c.requiresTrigger,
        memorySubjectJson: b.memorySubjectJson,
        displayName: b.displayName,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      })
      .from(b)
      .innerJoin(c, eq(c.id, b.conversationId))
      .innerJoin(pa, eq(pa.id, b.providerAccountId))
      .innerJoin(a, eq(a.id, b.agentId))
      .where(
        and(
          eq(b.appId, CANONICAL_APP_ID),
          like(b.id, `${CONVERSATION_ROUTE_BINDING_ID_PREFIX}%`),
          eq(b.status, 'active'),
          eq(pa.status, 'active'),
        ),
      )
      .orderBy(asc(b.createdAt));
  }
}

export function bindingRowToGroup(
  row: CanonicalBindingRecord,
): { jid: string; group: ConversationRoute } | undefined {
  if (!row.id.startsWith(CONVERSATION_ROUTE_BINDING_ID_PREFIX))
    return undefined;
  if (row.status !== 'active') return undefined;
  const routeSubject = parseJson<StoredLiveRouteProjection>(
    row.memorySubjectJson,
    {} as StoredLiveRouteProjection,
  );
  const bindingIdRouteKey = conversationRouteKeyFromBindingRow(row);
  if (!bindingIdRouteKey) return undefined;
  const providerAccountId = row.providerAccountId.trim();
  if (!providerAccountId) return undefined;
  const parsedRouteKey = parseAgentThreadQueueKey(bindingIdRouteKey);
  const normalizedRowAgentId = normalizeRouteAgentId(row.agentId);
  if (
    (parsedRouteKey.agentId !== undefined &&
      normalizeRouteAgentId(parsedRouteKey.agentId) !== normalizedRowAgentId) ||
    (parsedRouteKey.providerAccountId !== undefined &&
      parsedRouteKey.providerAccountId !== providerAccountId)
  ) {
    logger.warn(
      {
        event: 'conversation_route_row_conflicting_qualifiers',
        rowId: row.id,
        parsedAgentId: parsedRouteKey.agentId,
        rowAgentId: row.agentId,
        parsedProviderAccountId: parsedRouteKey.providerAccountId,
        rowProviderAccountId: providerAccountId,
      },
      'Skipped conflicting conversation route row during load',
    );
    return undefined;
  }
  const expectedCanonicalConversationId = conversationIdForJid(
    parsedRouteKey.chatJid,
    providerAccountId,
  );
  if (row.conversationId !== expectedCanonicalConversationId) {
    logger.warn(
      {
        event: 'conversation_route_conversation_id_noncanonical',
        rowId: row.id,
        storedConversationId: row.conversationId,
        expectedCanonicalConversationId,
      },
      'Loaded non-canonical conversation route conversation id',
    );
  }
  const folder =
    folderForAgentId(normalizedRowAgentId as AgentId) ?? row.agentId;
  const agentConfig = routeSubject.liveRoute?.agentConfig;
  const conversationKind =
    row.conversationKind === 'direct' || row.conversationKind === 'dm'
      ? 'dm'
      : 'channel';
  return {
    jid: bindingIdRouteKey,
    group: {
      name: row.displayName,
      folder,
      agentId: row.agentId,
      conversationId: row.conversationId,
      trigger: defaultTriggerForAgentName(row.agentName),
      added_at: row.createdAt,
      requiresTrigger: row.requiresTrigger,
      conversationKind,
      providerAccountId,
      ...(agentConfig ? { agentConfig } : {}),
    },
  };
}

interface RouteAliasCandidate {
  row: CanonicalBindingRecord;
  routeKey: string;
  tier: number;
}

function normalizeBindingRow(
  row: CanonicalBindingRecord,
): CanonicalBindingRecord {
  return {
    ...row,
    agentId: row.agentId.trim(),
    providerAccountId: row.providerAccountId.trim(),
  };
}

function routeAliasTier(
  row: CanonicalBindingRecord,
  routeKey: string,
): number | undefined {
  const parsed = parseAgentThreadQueueKey(routeKey);
  if (row.threadId || parsed.threadId) return undefined;
  if (!parsed.agentId && !parsed.providerAccountId) return 1;
  if (!parsed.agentId) return undefined;
  if (
    normalizeRouteAgentId(parsed.agentId) !== normalizeRouteAgentId(row.agentId)
  ) {
    return undefined;
  }
  if (!parsed.providerAccountId) return 2;
  return parsed.providerAccountId === row.providerAccountId ? 3 : undefined;
}

function compareRouteAliasPreference(
  left: RouteAliasCandidate,
  right: RouteAliasCandidate,
): number {
  if (left.tier !== right.tier) return right.tier - left.tier;

  const leftUpdatedAt = Date.parse(left.row.updatedAt ?? left.row.createdAt);
  const rightUpdatedAt = Date.parse(right.row.updatedAt ?? right.row.createdAt);
  const leftTimestamp = Number.isNaN(leftUpdatedAt)
    ? Number.NEGATIVE_INFINITY
    : leftUpdatedAt;
  const rightTimestamp = Number.isNaN(rightUpdatedAt)
    ? Number.NEGATIVE_INFINITY
    : rightUpdatedAt;
  if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
  if (left.routeKey === right.routeKey) return 0;
  return left.routeKey < right.routeKey ? -1 : 1;
}

export function bindingRowsToGroups(
  storedRows: CanonicalBindingRecord[],
): Record<string, ConversationRoute> {
  const rows = storedRows.map(normalizeBindingRow);
  const aliasesByIdentity = new Map<string, RouteAliasCandidate[]>();
  for (const row of rows) {
    if (row.status !== 'active' || row.threadId) continue;
    const routeKey = conversationRouteKeyFromBindingRow(row);
    if (!routeKey) continue;
    const parsed = parseAgentThreadQueueKey(routeKey);
    const tier = routeAliasTier(row, routeKey);
    if (tier === undefined) continue;
    const identity = `${parsed.chatJid}\0${normalizeRouteAgentId(row.agentId)}\0${row.providerAccountId}`;
    const aliases = aliasesByIdentity.get(identity) ?? [];
    aliases.push({ row, routeKey, tier });
    aliasesByIdentity.set(identity, aliases);
  }

  const droppedRows = new Set<CanonicalBindingRecord>();
  for (const aliases of aliasesByIdentity.values()) {
    if (aliases.length < 2) continue;
    const [winner, ...droppedAliases] = [...aliases].sort(
      compareRouteAliasPreference,
    );
    if (!winner) continue;
    for (const dropped of droppedAliases) {
      droppedRows.add(dropped.row);
      const parsed = parseAgentThreadQueueKey(dropped.routeKey);
      logger.warn(
        {
          event: 'conversation_route_alias_dropped',
          droppedRouteId: dropped.row.id,
          droppedConversationId: dropped.row.conversationId,
          keptRouteIds: [winner.row.id],
          keptConversationIds: [winner.row.conversationId],
          chatJid: parsed.chatJid,
          agentId: dropped.row.agentId,
          providerAccountId: dropped.row.providerAccountId,
        },
        'Dropped stale conversation route alias during load',
      );
    }
  }

  const result: Record<string, ConversationRoute> = {};
  for (const row of rows) {
    if (droppedRows.has(row)) continue;
    if (row.status === 'active') {
      const reason = !conversationRouteKeyFromBindingRow(row)
        ? 'missing_route_key'
        : !row.providerAccountId
          ? 'missing_provider_account_id'
          : undefined;
      if (reason) {
        logger.warn(
          {
            event: 'conversation_route_row_skipped',
            rowId: row.id,
            reason,
          },
          'Skipped malformed conversation route row during load',
        );
        continue;
      }
    }
    const binding = bindingRowToGroup(row);
    if (binding) result[binding.jid] = binding.group;
  }
  return result;
}
