import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import type { ChatInfo } from '../../../domain/repositories/domain-types.js';
import type {
  Job,
  JobEvent,
  JobRun,
  NewMessage,
  RegisteredGroup,
} from '../../../domain/repositories/domain-types.js';
import type {
  JobUpsertInput,
  OpsRepository,
} from '../../../domain/repositories/ops-repo.js';
import { PostgresChatMessageRepository } from './chat-message-repo.postgres.js';
import { PostgresJobRepository } from './job-repo.postgres.js';
import * as pgSchema from './schema.js';
import { PostgresSessionGroupRepository } from './session-group-repo.postgres.js';

export class PostgresOpsRepository implements OpsRepository {
  private readonly chatMessages: PostgresChatMessageRepository;
  private readonly jobs: PostgresJobRepository;
  private readonly sessionsAndGroups: PostgresSessionGroupRepository;

  constructor(
    private readonly pool: Pool,
    db: NodePgDatabase<typeof pgSchema>,
  ) {
    this.chatMessages = new PostgresChatMessageRepository(db);
    this.jobs = new PostgresJobRepository(db);
    this.sessionsAndGroups = new PostgresSessionGroupRepository(db);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void> {
    return this.chatMessages.storeChatMetadata(
      chatJid,
      timestamp,
      name,
      channel,
      isGroup,
    );
  }

  getAllChats(): Promise<ChatInfo[]> {
    return this.chatMessages.getAllChats();
  }

  storeMessage(msg: NewMessage): Promise<void> {
    return this.chatMessages.storeMessage(msg);
  }

  getNewMessages(
    jids: string[],
    lastCursor: string,
    limit?: number,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
    return this.chatMessages.getNewMessages(jids, lastCursor, limit);
  }

  getMessagesSince(
    chatJid: string,
    sinceCursor: string,
    limit?: number,
    options?: { threadId?: string | null },
  ): Promise<NewMessage[]> {
    return this.chatMessages.getMessagesSince(
      chatJid,
      sinceCursor,
      limit,
      options,
    );
  }

  getMessageThreadIds(chatJid: string): Promise<Array<string | null>> {
    return this.chatMessages.getMessageThreadIds(chatJid);
  }

  getLastBotMessageCursor(
    chatJid: string,
  ): Promise<{ timestamp: string; id: string } | undefined> {
    return this.chatMessages.getLastBotMessageCursor(chatJid);
  }

  getLastBotMessageTimestamp(chatJid: string): Promise<string | undefined> {
    return this.chatMessages.getLastBotMessageTimestamp(chatJid);
  }

  upsertJob(job: JobUpsertInput): Promise<{ created: boolean }> {
    return this.jobs.upsertJob(job);
  }

  getJobById(id: string): Promise<Job | undefined> {
    return this.jobs.getJobById(id);
  }

  getAllJobs(): Promise<Job[]> {
    return this.jobs.getAllJobs();
  }

  getRecentJobRuns(limit?: number): Promise<JobRun[]> {
    return this.jobs.getRecentJobRuns(limit);
  }

  updateJob(id: string, updates: Partial<Job>): Promise<void> {
    return this.jobs.updateJob(id, updates);
  }

  deleteJob(id: string): Promise<void> {
    return this.jobs.deleteJob(id);
  }

  deleteExpiredCompletedOneTimeJobs(nowIso?: string): Promise<number> {
    return this.jobs.deleteExpiredCompletedOneTimeJobs(nowIso);
  }

  claimDueJobRunStart(input: {
    jobId: string;
    runId: string;
    scheduledFor: string;
    startedAt: string;
    retryCount: number;
    leaseExpiresAt: string;
    requireNextRun?: boolean;
  }): Promise<boolean> {
    return this.jobs.claimDueJobRunStart(input);
  }

  releaseStaleJobLeases(nowIso?: string): Promise<number> {
    return this.jobs.releaseStaleJobLeases(nowIso);
  }

  createJobRun(run: JobRun): Promise<boolean> {
    return this.jobs.createJobRun(run);
  }

  completeJobRun(
    runId: string,
    status: JobRun['status'],
    resultSummary?: string | null,
    errorSummary?: string | null,
  ): Promise<void> {
    return this.jobs.completeJobRun(runId, status, resultSummary, errorSummary);
  }

  markJobRunNotified(runId: string): Promise<void> {
    return this.jobs.markJobRunNotified(runId);
  }

  getJobRunById(runId: string): Promise<JobRun | undefined> {
    return this.jobs.getJobRunById(runId);
  }

  listJobRuns(jobId?: string, limit?: number): Promise<JobRun[]> {
    return this.jobs.listJobRuns(jobId, limit);
  }

  listDeadLetterRuns(limit?: number): Promise<JobRun[]> {
    return this.jobs.listDeadLetterRuns(limit);
  }

  addJobEvent(event: Omit<JobEvent, 'id'>): Promise<void> {
    return this.jobs.addJobEvent(event);
  }

  listRecentJobEvents(
    limit?: number,
    filters?: { job_id?: string; run_id?: string; event_type?: string },
  ): Promise<JobEvent[]> {
    return this.jobs.listRecentJobEvents(limit, filters);
  }

  getRouterState(key: string): Promise<string | undefined> {
    return this.sessionsAndGroups.getRouterState(key);
  }

  setRouterState(key: string, value: string): Promise<void> {
    return this.sessionsAndGroups.setRouterState(key, value);
  }

  getSession(
    groupFolder: string,
    threadId?: string | null,
  ): Promise<string | undefined> {
    return this.sessionsAndGroups.getSession(groupFolder, threadId);
  }

  setSession(
    groupFolder: string,
    sessionId: string,
    threadId?: string | null,
  ): Promise<void> {
    return this.sessionsAndGroups.setSession(groupFolder, sessionId, threadId);
  }

  deleteSession(groupFolder: string, threadId?: string | null): Promise<void> {
    return this.sessionsAndGroups.deleteSession(groupFolder, threadId);
  }

  deleteSessionsByGroupFolder(groupFolder: string): Promise<void> {
    return this.sessionsAndGroups.deleteSessionsByGroupFolder(groupFolder);
  }

  getAllSessions(): Promise<Record<string, string>> {
    return this.sessionsAndGroups.getAllSessions();
  }

  getRegisteredGroup(jid: string): Promise<RegisteredGroup | undefined> {
    return this.sessionsAndGroups.getRegisteredGroup(jid);
  }

  setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
    return this.sessionsAndGroups.setRegisteredGroup(jid, group);
  }

  deleteRegisteredGroup(jid: string): Promise<void> {
    return this.sessionsAndGroups.deleteRegisteredGroup(jid);
  }

  getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
    return this.sessionsAndGroups.getAllRegisteredGroups();
  }
}
