import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import type { ReleasedStaleJobLease } from '../../../../domain/repositories/ops-repo.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export async function releaseStaleCanonicalJobLeases(
  db: CanonicalDb,
  nowIso: string,
): Promise<ReleasedStaleJobLease[]> {
  return releaseCanonicalJobLeases(db, nowIso, {
    errorSummary: 'Scheduler run lease expired before completion.',
    reason: 'lease_expired',
    staleOnly: true,
  });
}

export async function releaseInterruptedCanonicalJobLeases(
  db: CanonicalDb,
  nowIso: string,
): Promise<ReleasedStaleJobLease[]> {
  return releaseCanonicalJobLeases(db, nowIso, {
    errorSummary: 'Scheduler runtime restarted before completion.',
    reason: 'runtime_restarted',
    staleOnly: false,
    requireCanonicalLeaseOwner: true,
  });
}

async function releaseCanonicalJobLeases(
  db: CanonicalDb,
  nowIso: string,
  options: {
    errorSummary: string;
    reason: ReleasedStaleJobLease['reason'];
    staleOnly: boolean;
    requireCanonicalLeaseOwner?: boolean;
  },
): Promise<ReleasedStaleJobLease[]> {
  return db.transaction(async (tx) => {
    const jobs = pgSchema.canonicalJobsPostgres;
    const runs = pgSchema.agentRunsPostgres;
    const stalePredicate = and(
      eq(jobs.status, 'running'),
      isNotNull(jobs.leaseExpiresAt),
      lt(jobs.leaseExpiresAt, nowIso),
    );
    const interruptedPredicate = and(
      eq(jobs.status, 'running'),
      isNotNull(jobs.leaseRunId),
    );
    const predicate = options.staleOnly ? stalePredicate : interruptedPredicate;
    const candidateJobs = await tx
      .select({
        id: jobs.id,
        leaseRunId: jobs.leaseRunId,
        leaseOwner: sql<string>`${jobs.targetJson} #>> '{executionContext,conversationJid}'`,
      })
      .from(jobs)
      .where(predicate);
    const candidateRunIds = candidateJobs
      .map((job) => job.leaseRunId)
      .filter((runId): runId is string => Boolean(runId));
    const ownedRunIds =
      options.requireCanonicalLeaseOwner && candidateRunIds.length > 0
        ? new Set(
            (
              await tx
                .select({ id: runs.id, leaseOwner: runs.leaseOwner })
                .from(runs)
                .where(
                  and(
                    inArray(runs.id, candidateRunIds),
                    isNotNull(runs.leaseOwner),
                  ),
                )
            )
              .filter((run) =>
                candidateJobs.some(
                  (job) =>
                    job.leaseRunId === run.id &&
                    job.leaseOwner &&
                    job.leaseOwner === run.leaseOwner,
                ),
              )
              .map((run) => run.id),
          )
        : undefined;
    const staleJobs = ownedRunIds
      ? candidateJobs.filter(
          (job) => job.leaseRunId && ownedRunIds.has(job.leaseRunId),
        )
      : candidateJobs;
    if (staleJobs.length === 0) return [];
    const releasePredicate = and(
      inArray(
        jobs.id,
        staleJobs.map((job) => job.id),
      ),
      predicate,
      ownedRunIds && ownedRunIds.size > 0
        ? inArray(jobs.leaseRunId, [...ownedRunIds])
        : undefined,
    );
    const releasedJobs = await tx
      .update(jobs)
      .set({
        status: 'active',
        leaseRunId: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      })
      .where(releasePredicate)
      .returning({ id: jobs.id });
    const releasedJobIds = new Set(releasedJobs.map((job) => job.id));
    const releasedStaleJobs = staleJobs.filter((job) =>
      releasedJobIds.has(job.id),
    );
    const runIds = releasedStaleJobs
      .map((job) => job.leaseRunId)
      .filter((runId): runId is string => Boolean(runId));
    const timedOutRunIds = new Set<string>();
    if (runIds.length > 0) {
      const timedOutRows = await tx
        .update(runs)
        .set({
          status: 'timeout',
          endedAt: nowIso,
          errorSummary: options.errorSummary,
        })
        .where(and(inArray(runs.id, runIds), eq(runs.status, 'running')))
        .returning({ id: runs.id });
      for (const row of timedOutRows) timedOutRunIds.add(row.id);
    }
    return releasedStaleJobs.map((job) => ({
      jobId: job.id,
      runId: job.leaseRunId,
      releasedAt: nowIso,
      runTimedOut: job.leaseRunId ? timedOutRunIds.has(job.leaseRunId) : false,
      reason: options.reason,
    }));
  });
}
