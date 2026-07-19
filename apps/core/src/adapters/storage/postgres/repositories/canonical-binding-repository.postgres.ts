import { and, asc, eq, like } from 'drizzle-orm';

import type { ConversationRoute } from '../../../../domain/repositories/domain-types.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import { parseAgentThreadQueueKey } from '../../../../application/provider-conversations/thread-queue-key.js';
import { defaultTriggerForAgentName } from '../../../../shared/trigger-pattern.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
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
}

const CONVERSATION_ROUTE_BINDING_ID_PREFIX = 'conversation-route:';

function routeBindingId(jid: string): string {
  return `${CONVERSATION_ROUTE_BINDING_ID_PREFIX}${jid}`;
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
      conversationId: group.conversationId,
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
    const { chatJid } = parseAgentThreadQueueKey(jid);
    await this.db.transaction(async (tx) => {
      const conversationId = await this.graph.ensureConversation(
        chatJid,
        {
          name: group.name,
          agentFolder: group.folder,
          providerAccountId: group.providerAccountId,
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
      const providerAccountId = await this.graph.getConversationInstallationId(
        conversationId,
        tx,
      );
      if (!providerAccountId) return;
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
  if (!row.id.startsWith(CONVERSATION_ROUTE_BINDING_ID_PREFIX)) {
    return undefined;
  }
  if (row.status !== 'active') return undefined;
  const routeSubject = parseJson<StoredLiveRouteProjection>(
    row.memorySubjectJson,
    {} as StoredLiveRouteProjection,
  );
  const bindingIdRouteKey = row.id.slice(
    CONVERSATION_ROUTE_BINDING_ID_PREFIX.length,
  );
  if (!bindingIdRouteKey) return undefined;
  const folder = row.agentId.startsWith('agent:')
    ? row.agentId.slice('agent:'.length)
    : row.agentId;
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
      conversationId:
        routeSubject.liveRoute?.conversationId ?? row.conversationId,
      trigger: defaultTriggerForAgentName(row.agentName),
      added_at: row.createdAt,
      requiresTrigger: row.requiresTrigger,
      conversationKind,
      providerAccountId: row.providerAccountId,
      ...(agentConfig ? { agentConfig } : {}),
    },
  };
}
