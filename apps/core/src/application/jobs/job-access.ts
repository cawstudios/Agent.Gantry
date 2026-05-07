import type { Job } from '../../domain/types.js';
import { ApplicationError } from '../common/application-error.js';
import type {
  AppSessionRecord,
  JobControlPort,
} from './job-management-types.js';

export function jobBelongsToApp(job: Job, appId: string): boolean {
  const linkedSessions = Array.isArray(job.linked_sessions)
    ? job.linked_sessions
    : [];
  const appSessions = linkedSessions.filter((conversationJid) =>
    conversationJid.startsWith('app:'),
  );
  if (appSessions.length === 0) return false;
  return appSessions.every((conversationJid) =>
    appChatJidBelongsToApp(conversationJid, appId),
  );
}

export function resolveJobRuntimeAppId(job: Job, fallback = 'default'): string {
  const appJid = (
    Array.isArray(job.linked_sessions) ? job.linked_sessions : []
  ).find((conversationJid) => conversationJid.startsWith('app:'));
  if (!appJid) return fallback;
  const rest = appJid.slice('app:'.length);
  const delimiterIndex = rest.indexOf(':');
  if (delimiterIndex <= 0 || rest.indexOf(':', delimiterIndex + 1) !== -1) {
    return fallback;
  }
  return rest.slice(0, delimiterIndex) || fallback;
}

export function assertJobBelongsToApp(job: Job, appId: string): void {
  if (!jobBelongsToApp(job, appId)) {
    throw new ApplicationError('FORBIDDEN', 'API key cannot access this job');
  }
}

export async function resolveJobAppSession(input: {
  control: JobControlPort;
  job: Job;
  appId: string;
}): Promise<AppSessionRecord | undefined> {
  const { appId, control, job } = input;
  if (job.session_id) {
    const session = await control.getAppSessionById(job.session_id);
    if (session?.appId === appId) return session;
    return undefined;
  }
  return undefined;
}

export async function filterJobsByCanonicalAppSession(input: {
  control: JobControlPort;
  jobs: readonly Job[];
  appId: string;
}): Promise<Job[]> {
  const sessionIds = Array.from(
    new Set(
      input.jobs
        .map((job) => job.session_id?.trim())
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ),
  );
  if (sessionIds.length === 0) {
    return input.jobs.filter((job) => jobBelongsToApp(job, input.appId));
  }
  const sessions = await input.control.getAppSessionsByIds(sessionIds);
  const allowedSessionIds = new Set(
    sessions
      .filter((session) => session.appId === input.appId)
      .map((session) => session.sessionId),
  );
  return input.jobs.filter((job) => {
    if (job.session_id) return allowedSessionIds.has(job.session_id);
    return jobBelongsToApp(job, input.appId);
  });
}

function appChatJidBelongsToApp(
  conversationJid: string,
  appId: string,
): boolean {
  const rest = conversationJid.slice('app:'.length);
  const delimiterIndex = rest.indexOf(':');
  if (delimiterIndex <= 0 || rest.indexOf(':', delimiterIndex + 1) !== -1) {
    return false;
  }
  return rest.slice(0, delimiterIndex) === appId;
}
