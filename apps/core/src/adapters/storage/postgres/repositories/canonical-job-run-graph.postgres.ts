import { and, eq } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  DEFAULT_LLM_PROFILE_ID,
  type PostgresCanonicalGraphRepository,
  configVersionIdForAgent,
  parseJson,
} from './canonical-graph-repository.postgres.js';

type CanonicalExecutor =
  | CanonicalDb
  | Parameters<Parameters<CanonicalDb['transaction']>[0]>[0];

export interface CanonicalJobRunGraph {
  appId: string;
  agentId: string;
  configVersionId: string;
  llmProfileId: string;
}

export async function resolveCanonicalJobRunGraph(input: {
  jobId: string;
  executor: CanonicalExecutor;
  graph: PostgresCanonicalGraphRepository;
}): Promise<CanonicalJobRunGraph> {
  const rows = await input.executor
    .select()
    .from(pgSchema.canonicalJobsPostgres)
    .where(eq(pgSchema.canonicalJobsPostgres.id, input.jobId))
    .limit(1);
  const row = rows[0];

  if (row?.appId && row.appId !== CANONICAL_APP_ID) {
    const agentId = row.agentId?.trim();
    if (!agentId) {
      throw new Error(`App-owned job ${input.jobId} has no agent identity.`);
    }
    const agentRows = await input.executor
      .select({
        currentConfigVersionId: pgSchema.agentsPostgres.currentConfigVersionId,
      })
      .from(pgSchema.agentsPostgres)
      .where(
        and(
          eq(pgSchema.agentsPostgres.id, agentId),
          eq(pgSchema.agentsPostgres.appId, row.appId),
        ),
      )
      .limit(1);
    const configVersionId = agentRows[0]?.currentConfigVersionId?.trim();
    if (!configVersionId) {
      throw new Error(
        `App-owned job ${input.jobId} has no active agent configuration.`,
      );
    }
    const configRows = await input.executor
      .select({
        llmProfileId: pgSchema.agentConfigVersionsPostgres.llmProfileId,
      })
      .from(pgSchema.agentConfigVersionsPostgres)
      .where(
        and(
          eq(pgSchema.agentConfigVersionsPostgres.id, configVersionId),
          eq(pgSchema.agentConfigVersionsPostgres.appId, row.appId),
          eq(pgSchema.agentConfigVersionsPostgres.agentId, agentId),
        ),
      )
      .limit(1);
    const llmProfileId = configRows[0]?.llmProfileId?.trim();
    if (!llmProfileId) {
      throw new Error(
        `App-owned job ${input.jobId} has no active model configuration.`,
      );
    }
    return {
      appId: row.appId,
      agentId,
      configVersionId,
      llmProfileId,
    };
  }

  const target = row
    ? parseJson<Record<string, unknown>>(row.targetJson, {})
    : {};
  const executionContext =
    target.executionContext &&
    typeof target.executionContext === 'object' &&
    !Array.isArray(target.executionContext)
      ? (target.executionContext as Record<string, unknown>)
      : undefined;
  const folder = row
    ? ((executionContext?.workspaceKey as string | undefined) ??
      row.agentId?.replace(/^agent:/, '') ??
      'system')
    : 'system';
  const agentId = await input.graph.ensureAgentExists(
    folder,
    folder,
    input.executor,
  );
  return {
    appId: row?.appId ?? CANONICAL_APP_ID,
    agentId,
    configVersionId: configVersionIdForAgent(agentId),
    llmProfileId: DEFAULT_LLM_PROFILE_ID,
  };
}
