import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { nowIso as currentIso } from '../../time/datetime.js';
import type { Job, JobEvent, JobRun } from '../../../domain/types.js';
import type { JobUpsertInput } from '../../../domain/repositories/ops-repo.js';
import {
  mapJobEventRow,
  mapJobRow,
  mapJobRunRow,
  normalizeJobExecutionMode,
} from './ops-common.postgres.js';
import * as pgSchema from './schema.js';

export class PostgresJobRepository {
  constructor(private readonly db: NodePgDatabase<typeof pgSchema>) {}

  async upsertJob(job: JobUpsertInput): Promise<{ created: boolean }> {
    const j = pgSchema.jobsPostgres;
    const now = currentIso();
    return this.db.transaction(async (tx) => {
      const existing = (
        await tx
          .select({ status: j.status })
          .from(j)
          .where(eq(j.id, job.id))
          .limit(1)
      )[0];
      const created = !existing;
      const requestedStatus = job.status || 'active';
      const nextStatus =
        existing?.status === 'running' || existing?.status === 'dead_lettered'
          ? existing.status
          : requestedStatus;
      await tx
        .insert(j)
        .values({
          id: job.id,
          name: job.name,
          prompt: job.prompt,
          model: job.model || null,
          script: job.script || null,
          scheduleType: job.schedule_type,
          scheduleValue: job.schedule_value,
          status: nextStatus,
          linkedSessions: JSON.stringify(job.linked_sessions),
          sessionId: job.session_id || null,
          threadId: job.thread_id || null,
          groupScope: job.group_scope,
          createdBy: job.created_by || 'agent',
          createdAt: job.created_at || now,
          updatedAt: job.updated_at || now,
          nextRun: job.next_run ?? null,
          lastRun: job.last_run ?? null,
          silent: Boolean(job.silent),
          cleanupAfterMs: job.cleanup_after_ms ?? 86400000,
          timeoutMs: job.timeout_ms ?? 300000,
          maxRetries: job.max_retries ?? 3,
          retryBackoffMs: job.retry_backoff_ms ?? 5000,
          maxConsecutiveFailures: job.max_consecutive_failures ?? 5,
          consecutiveFailures: job.consecutive_failures ?? 0,
          executionMode: normalizeJobExecutionMode(job.execution_mode),
          leaseRunId: job.lease_run_id ?? null,
          leaseExpiresAt: job.lease_expires_at ?? null,
          pauseReason: job.pause_reason ?? null,
        })
        .onConflictDoUpdate({
          target: j.id,
          set: {
            name: job.name,
            prompt: job.prompt,
            model: job.model || null,
            script: job.script || null,
            scheduleType: job.schedule_type,
            scheduleValue: job.schedule_value,
            status: nextStatus,
            linkedSessions: JSON.stringify(job.linked_sessions),
            sessionId: job.session_id || null,
            threadId: job.thread_id || null,
            groupScope: job.group_scope,
            updatedAt: job.updated_at || now,
            nextRun: job.next_run ?? null,
            silent: Boolean(job.silent),
            cleanupAfterMs: job.cleanup_after_ms ?? 86400000,
            timeoutMs: job.timeout_ms ?? 300000,
            maxRetries: job.max_retries ?? 3,
            retryBackoffMs: job.retry_backoff_ms ?? 5000,
            maxConsecutiveFailures: job.max_consecutive_failures ?? 5,
            executionMode: normalizeJobExecutionMode(job.execution_mode),
          },
        });
      return { created };
    });
  }

  async getJobById(id: string): Promise<Job | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.jobsPostgres)
      .where(eq(pgSchema.jobsPostgres.id, id))
      .limit(1);
    return rows[0] ? mapJobRow(rows[0]) : undefined;
  }

  async getAllJobs(): Promise<Job[]> {
    const rows = await this.db
      .select()
      .from(pgSchema.jobsPostgres)
      .orderBy(
        desc(pgSchema.jobsPostgres.updatedAt),
        desc(pgSchema.jobsPostgres.createdAt),
      );
    return rows.map((row) => mapJobRow(row));
  }

  async getRecentJobRuns(limit = 200): Promise<JobRun[]> {
    return this.listJobRuns(undefined, limit);
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<void> {
    const setValues: Partial<typeof pgSchema.jobsPostgres.$inferInsert> = {
      updatedAt: currentIso(),
    };
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.prompt !== undefined) setValues.prompt = updates.prompt;
    if (updates.model !== undefined) setValues.model = updates.model || null;
    if (updates.script !== undefined) setValues.script = updates.script || null;
    if (updates.schedule_type !== undefined)
      setValues.scheduleType = updates.schedule_type;
    if (updates.schedule_value !== undefined)
      setValues.scheduleValue = updates.schedule_value;
    if (updates.status !== undefined) setValues.status = updates.status;
    if (updates.linked_sessions !== undefined)
      setValues.linkedSessions = JSON.stringify(updates.linked_sessions);
    if (updates.session_id !== undefined)
      setValues.sessionId = updates.session_id;
    if (updates.thread_id !== undefined) setValues.threadId = updates.thread_id;
    if (updates.group_scope !== undefined)
      setValues.groupScope = updates.group_scope;
    if (updates.next_run !== undefined) setValues.nextRun = updates.next_run;
    if (updates.last_run !== undefined) setValues.lastRun = updates.last_run;
    if (updates.silent !== undefined)
      setValues.silent = Boolean(updates.silent);
    if (updates.cleanup_after_ms !== undefined)
      setValues.cleanupAfterMs = updates.cleanup_after_ms;
    if (updates.timeout_ms !== undefined)
      setValues.timeoutMs = updates.timeout_ms;
    if (updates.max_retries !== undefined)
      setValues.maxRetries = updates.max_retries;
    if (updates.retry_backoff_ms !== undefined)
      setValues.retryBackoffMs = updates.retry_backoff_ms;
    if (updates.max_consecutive_failures !== undefined)
      setValues.maxConsecutiveFailures = updates.max_consecutive_failures;
    if (updates.consecutive_failures !== undefined)
      setValues.consecutiveFailures = updates.consecutive_failures;
    if (updates.execution_mode !== undefined)
      setValues.executionMode = normalizeJobExecutionMode(
        updates.execution_mode,
      );
    if (updates.pause_reason !== undefined)
      setValues.pauseReason = updates.pause_reason;
    if (updates.lease_run_id !== undefined)
      setValues.leaseRunId = updates.lease_run_id;
    if (updates.lease_expires_at !== undefined)
      setValues.leaseExpiresAt = updates.lease_expires_at;
    if (Object.keys(setValues).length === 1) return;
    await this.db
      .update(pgSchema.jobsPostgres)
      .set(setValues)
      .where(eq(pgSchema.jobsPostgres.id, id));
  }

  async deleteJob(id: string): Promise<void> {
    await this.db
      .delete(pgSchema.jobsPostgres)
      .where(eq(pgSchema.jobsPostgres.id, id));
  }

  async deleteExpiredCompletedOneTimeJobs(
    nowIso: string = currentIso(),
  ): Promise<number> {
    const nowMs = Date.parse(nowIso);
    const j = pgSchema.jobsPostgres;
    const rows = await this.db
      .delete(j)
      .where(
        and(
          eq(j.scheduleType, 'once'),
          inArray(j.status, ['completed', 'dead_lettered']),
          sql`(${j.cleanupAfterMs} = 0 OR (${nowMs} - (EXTRACT(EPOCH FROM COALESCE(${j.lastRun}, ${j.updatedAt}, ${j.createdAt})::timestamptz) * 1000)) >= ${j.cleanupAfterMs})`,
        ),
      )
      .returning({ id: j.id });
    return rows.length;
  }

  async claimDueJobRunStart(input: {
    jobId: string;
    runId: string;
    scheduledFor: string;
    startedAt: string;
    retryCount: number;
    leaseExpiresAt: string;
    requireNextRun?: boolean;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const jobConditions = [
        eq(pgSchema.jobsPostgres.id, input.jobId),
        eq(pgSchema.jobsPostgres.status, 'active'),
      ];
      if (input.requireNextRun !== false) {
        jobConditions.push(
          eq(pgSchema.jobsPostgres.nextRun, input.scheduledFor),
        );
      }
      const claimed = await tx
        .update(pgSchema.jobsPostgres)
        .set({
          status: 'running',
          leaseRunId: input.runId,
          leaseExpiresAt: input.leaseExpiresAt,
          updatedAt: input.startedAt,
        })
        .where(and(...jobConditions))
        .returning({ id: pgSchema.jobsPostgres.id });
      if (claimed.length < 1) return false;

      const runRows = await tx
        .insert(pgSchema.jobRunsPostgres)
        .values({
          runId: input.runId,
          jobId: input.jobId,
          scheduledFor: input.scheduledFor,
          startedAt: input.startedAt,
          endedAt: null,
          status: 'running',
          resultSummary: null,
          errorSummary: null,
          retryCount: input.retryCount,
          notifiedAt: null,
        })
        .onConflictDoNothing()
        .returning({ runId: pgSchema.jobRunsPostgres.runId });
      if (runRows.length > 0) return true;

      await tx
        .update(pgSchema.jobsPostgres)
        .set({
          status: 'active',
          leaseRunId: null,
          leaseExpiresAt: null,
          updatedAt: input.startedAt,
        })
        .where(eq(pgSchema.jobsPostgres.id, input.jobId));
      return false;
    });
  }

  async releaseStaleJobLeases(nowIso: string = currentIso()): Promise<number> {
    const rows = await this.db
      .update(pgSchema.jobsPostgres)
      .set({
        status: 'active',
        leaseRunId: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(pgSchema.jobsPostgres.status, 'running'),
          isNotNull(pgSchema.jobsPostgres.leaseExpiresAt),
          lt(pgSchema.jobsPostgres.leaseExpiresAt, nowIso),
        ),
      )
      .returning({ id: pgSchema.jobsPostgres.id });
    return rows.length;
  }

  async createJobRun(run: JobRun): Promise<boolean> {
    const rows = await this.db
      .insert(pgSchema.jobRunsPostgres)
      .values({
        runId: run.run_id,
        jobId: run.job_id,
        scheduledFor: run.scheduled_for,
        startedAt: run.started_at,
        endedAt: run.ended_at,
        status: run.status,
        resultSummary: run.result_summary,
        errorSummary: run.error_summary,
        retryCount: run.retry_count,
        notifiedAt: run.notified_at,
      })
      .onConflictDoNothing()
      .returning({ runId: pgSchema.jobRunsPostgres.runId });
    return rows.length > 0;
  }

  async completeJobRun(
    runId: string,
    status: JobRun['status'],
    resultSummary: string | null = null,
    errorSummary: string | null = null,
  ): Promise<void> {
    await this.db
      .update(pgSchema.jobRunsPostgres)
      .set({ status, endedAt: currentIso(), resultSummary, errorSummary })
      .where(eq(pgSchema.jobRunsPostgres.runId, runId));
  }

  async markJobRunNotified(runId: string): Promise<void> {
    await this.db
      .update(pgSchema.jobRunsPostgres)
      .set({ notifiedAt: currentIso() })
      .where(eq(pgSchema.jobRunsPostgres.runId, runId));
  }

  async getJobRunById(runId: string): Promise<JobRun | undefined> {
    const rows = await this.db
      .select()
      .from(pgSchema.jobRunsPostgres)
      .where(eq(pgSchema.jobRunsPostgres.runId, runId))
      .limit(1);
    return rows[0] ? mapJobRunRow(rows[0]) : undefined;
  }

  async listJobRuns(jobId?: string, limit = 50): Promise<JobRun[]> {
    const clampedLimit = Math.max(1, Math.min(limit, 500));
    const jr = pgSchema.jobRunsPostgres;
    const rows = jobId
      ? await this.db
          .select()
          .from(jr)
          .where(eq(jr.jobId, jobId))
          .orderBy(desc(jr.startedAt))
          .limit(clampedLimit)
      : await this.db
          .select()
          .from(jr)
          .orderBy(desc(jr.startedAt))
          .limit(clampedLimit);
    return rows.map((row) => mapJobRunRow(row));
  }

  async listDeadLetterRuns(limit = 50): Promise<JobRun[]> {
    const clampedLimit = Math.max(1, Math.min(limit, 500));
    const rows = await this.db
      .select()
      .from(pgSchema.jobRunsPostgres)
      .where(eq(pgSchema.jobRunsPostgres.status, 'dead_lettered'))
      .orderBy(desc(pgSchema.jobRunsPostgres.startedAt))
      .limit(clampedLimit);
    return rows.map((row) => mapJobRunRow(row));
  }

  async addJobEvent(event: Omit<JobEvent, 'id'>): Promise<void> {
    await this.db.insert(pgSchema.jobEventsPostgres).values({
      jobId: event.job_id,
      runId: event.run_id,
      eventType: event.event_type,
      payload: event.payload,
      createdAt: event.created_at,
    });
  }

  async listRecentJobEvents(
    limit = 200,
    filters?: { job_id?: string; run_id?: string; event_type?: string },
  ): Promise<JobEvent[]> {
    const clampedLimit = Math.max(1, Math.min(limit, 2000));
    const e = pgSchema.jobEventsPostgres;
    const conditions = [];
    if (filters?.job_id) conditions.push(eq(e.jobId, filters.job_id));
    if (filters?.run_id) conditions.push(eq(e.runId, filters.run_id));
    if (filters?.event_type)
      conditions.push(eq(e.eventType, filters.event_type));
    const rows = await this.db
      .select()
      .from(e)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(e.createdAt), desc(e.id))
      .limit(clampedLimit);
    return rows.map((row) => mapJobEventRow(row));
  }
}
