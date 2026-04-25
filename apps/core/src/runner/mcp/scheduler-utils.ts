import { threadId } from './context.js';

export function resolveSchedulerThreadArg(
  requestedThreadId: string | undefined,
  useAmbientDefault: boolean,
): { threadId?: string; error?: string } {
  if (requestedThreadId !== undefined) {
    const requested = requestedThreadId.trim();
    if (requested && requested !== threadId) {
      return {
        error:
          'thread_id can only target the current thread/topic for this agent run.',
      };
    }
    return { threadId: requested };
  }
  return useAmbientDefault && threadId ? { threadId } : {};
}

export function normalizeExecutionMode(
  executionMode: unknown,
  serialize: unknown,
): 'parallel' | 'serialized' {
  if (executionMode === 'serialized') return 'serialized';
  if (executionMode === 'parallel') return 'parallel';
  if (typeof serialize === 'boolean') {
    return serialize ? 'serialized' : 'parallel';
  }
  return 'parallel';
}

export function filterSchedulerEvents(
  events: unknown[],
  args: {
    job_id?: string;
    run_id?: string;
    event_type?: string;
    since_id?: number;
    since?: string;
  },
): Array<{
  id?: number;
  job_id?: string;
  run_id?: string | null;
  event_type?: string;
  payload?: string | null;
  created_at?: string;
}> {
  const sinceTimestamp = args.since ? Date.parse(args.since) : NaN;
  return events.filter((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const row = item as {
      id?: number;
      job_id?: string;
      run_id?: string | null;
      event_type?: string;
      created_at?: string;
    };
    if (args.job_id && row.job_id !== args.job_id) return false;
    if (args.run_id && row.run_id !== args.run_id) return false;
    if (args.event_type && row.event_type !== args.event_type) return false;
    if (
      typeof args.since_id === 'number' &&
      Number.isFinite(args.since_id) &&
      typeof row.id === 'number' &&
      row.id <= args.since_id
    ) {
      return false;
    }
    if (!Number.isNaN(sinceTimestamp) && row.created_at) {
      const created = Date.parse(row.created_at);
      if (Number.isFinite(created) && created <= sinceTimestamp) return false;
    }
    return true;
  }) as Array<{
    id?: number;
    job_id?: string;
    run_id?: string | null;
    event_type?: string;
    payload?: string | null;
    created_at?: string;
  }>;
}
