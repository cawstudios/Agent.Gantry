import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';

import type { ReleasedStaleJobLease } from '../../../../domain/repositories/ops-repo.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export async function releaseStaleCanonicalJobLeases(
  db: CanonicalDb,
  nowIso: string,
): Promise<ReleasedStaleJobLease[]> {
  return db.transaction(async (tx) => {
    const jobs = pgSchema.canonicalJobsPostgres;
    const runs = pgSchema.agentRunsPostgres;
    const staleJobs = await tx
      .select({ id: jobs.id, leaseRunId: jobs.leaseRunId })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'running'),
          isNotNull(jobs.leaseExpiresAt),
          lt(jobs.leaseExpiresAt, nowIso),
        ),
      );
    if (staleJobs.length === 0) return [];
    await tx
      .update(jobs)
      .set({
        status: 'active',
        leaseRunId: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      })
      .where(
        inArray(
          jobs.id,
          staleJobs.map((job) => job.id),
        ),
      );
    const runIds = staleJobs
      .map((job) => job.leaseRunId)
      .filter((runId): runId is string => Boolean(runId));
    const timedOutRunIds = new Set<string>();
    if (runIds.length > 0) {
      const timedOutRows = await tx
        .update(runs)
        .set({
          status: 'timeout',
          endedAt: nowIso,
          errorSummary: 'Scheduler run lease expired before completion.',
        })
        .where(and(inArray(runs.id, runIds), eq(runs.status, 'running')))
        .returning({ id: runs.id });
      for (const row of timedOutRows) timedOutRunIds.add(row.id);
    }
    return staleJobs.map((job) => ({
      jobId: job.id,
      runId: job.leaseRunId,
      releasedAt: nowIso,
      runTimedOut: job.leaseRunId ? timedOutRunIds.has(job.leaseRunId) : false,
    }));
  });
}
