import { and, desc, eq } from 'drizzle-orm';

import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';

const DEFAULT_LLM_PROFILE_ID = 'llm:default';
const CONTROL_PROVIDER_ID = 'app';

function agentIdForFolder(folder: string): string {
  return `agent:${folder || 'default'}`;
}

function controlInstallationId(appId: string): string {
  return `control:${appId}`;
}

function controlConversationId(appId: string, externalConversationId: string) {
  return `control:${appId}:conversation:${externalConversationId}`;
}

export async function ensureControlGraph(
  db: CanonicalExecutor,
  input: {
    appId: string;
    externalConversationId: string;
    externalConversationRef: string;
    agentFolder: string;
    agentId?: string;
    title?: string | null;
  },
) {
  const now = currentIso();
  const appId = input.appId;
  const agentId = input.agentId ?? agentIdForFolder(input.agentFolder);
  const providerAccountId = controlInstallationId(appId);
  const conversationId = controlConversationId(
    appId,
    input.externalConversationId,
  );
  await db
    .insert(pgSchema.appsPostgres)
    .values({
      id: appId,
      slug: appId,
      name: appId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pgSchema.appsPostgres.id,
      set: { updatedAt: now },
    });
  await db
    .insert(pgSchema.llmProfilesPostgres)
    .values({
      id: DEFAULT_LLM_PROFILE_ID,
      appId,
      purpose: 'default',
      responseFamily: 'anthropic',
      modelAlias: 'opus',
      thinkingJson: '{}',
      budgetJson: '{}',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  if (!input.agentId) {
    await db
      .insert(pgSchema.agentsPostgres)
      .values({
        id: agentId,
        appId,
        name: input.agentFolder || 'default',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentsPostgres.id,
        set: {
          name: input.agentFolder || 'default',
          updatedAt: now,
        },
      });
  }
  await ensureAppScopedAgentConfig(db, { appId, agentId, now });
  await db
    .insert(pgSchema.providersPostgres)
    .values({
      id: CONTROL_PROVIDER_ID,
      displayName: 'App',
      capabilityFlagsJson: '[]',
      createdAt: now,
    })
    .onConflictDoNothing();
  await db
    .insert(pgSchema.providerAccountsPostgres)
    .values({
      id: providerAccountId,
      appId,
      agentId,
      providerId: CONTROL_PROVIDER_ID,
      externalIdentityRefJson: JSON.stringify({ adapter: 'app', appId }),
      label: 'App',
      status: 'active',
      runtimeSecretRefsJson: '{}',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pgSchema.providerAccountsPostgres.id,
      set: {
        providerId: CONTROL_PROVIDER_ID,
        agentId,
        externalIdentityRefJson: JSON.stringify({ adapter: 'app', appId }),
        label: 'App',
        status: 'active',
        runtimeSecretRefsJson: '{}',
        updatedAt: now,
      },
    });
  await db
    .insert(pgSchema.conversationsPostgres)
    .values({
      id: conversationId,
      appId,
      providerAccountId: providerAccountId,
      externalRefJson: JSON.stringify({
        externalConversationId: input.externalConversationId,
        externalConversationRef: input.externalConversationRef,
      }),
      kind: 'app',
      title: input.title ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pgSchema.conversationsPostgres.id,
      set: {
        externalRefJson: JSON.stringify({
          externalConversationId: input.externalConversationId,
          externalConversationRef: input.externalConversationRef,
        }),
        title: input.title ?? null,
        updatedAt: now,
      },
    });
  return { agentId, conversationId };
}

async function ensureAppScopedAgentConfig(
  db: CanonicalExecutor,
  input: { appId: string; agentId: string; now: string },
): Promise<void> {
  const [agent] = await db
    .select({
      currentConfigVersionId: pgSchema.agentsPostgres.currentConfigVersionId,
    })
    .from(pgSchema.agentsPostgres)
    .where(
      and(
        eq(pgSchema.agentsPostgres.id, input.agentId),
        eq(pgSchema.agentsPostgres.appId, input.appId),
      ),
    )
    .limit(1);
  if (!agent) {
    throw new Error(
      `Agent ${input.agentId} does not belong to app ${input.appId}.`,
    );
  }

  const configs = await db
    .select({
      id: pgSchema.agentConfigVersionsPostgres.id,
      appId: pgSchema.agentConfigVersionsPostgres.appId,
      version: pgSchema.agentConfigVersionsPostgres.version,
    })
    .from(pgSchema.agentConfigVersionsPostgres)
    .where(eq(pgSchema.agentConfigVersionsPostgres.agentId, input.agentId))
    .orderBy(desc(pgSchema.agentConfigVersionsPostgres.version));
  if (
    configs.some(
      (config) =>
        config.id === agent.currentConfigVersionId &&
        config.appId === input.appId,
    )
  ) {
    return;
  }

  let config = configs.find((candidate) => candidate.appId === input.appId);
  if (!config) {
    const version = (configs[0]?.version ?? 0) + 1;
    const id = `config:${input.agentId}:${version}`;
    await db
      .insert(pgSchema.agentConfigVersionsPostgres)
      .values({
        id,
        appId: input.appId,
        agentId: input.agentId,
        version,
        promptProfileRef: 'runtime-default',
        llmProfileId: DEFAULT_LLM_PROFILE_ID,
        createdAt: input.now,
      })
      .onConflictDoNothing();
    const [created] = await db
      .select({
        id: pgSchema.agentConfigVersionsPostgres.id,
        appId: pgSchema.agentConfigVersionsPostgres.appId,
        version: pgSchema.agentConfigVersionsPostgres.version,
      })
      .from(pgSchema.agentConfigVersionsPostgres)
      .where(
        and(
          eq(pgSchema.agentConfigVersionsPostgres.agentId, input.agentId),
          eq(pgSchema.agentConfigVersionsPostgres.appId, input.appId),
          eq(pgSchema.agentConfigVersionsPostgres.version, version),
        ),
      )
      .limit(1);
    if (!created) {
      throw new Error(
        `Unable to create an app-scoped configuration for agent ${input.agentId}.`,
      );
    }
    config = created;
  }

  await db
    .update(pgSchema.agentsPostgres)
    .set({ currentConfigVersionId: config.id, updatedAt: input.now })
    .where(
      and(
        eq(pgSchema.agentsPostgres.id, input.agentId),
        eq(pgSchema.agentsPostgres.appId, input.appId),
      ),
    );
}
