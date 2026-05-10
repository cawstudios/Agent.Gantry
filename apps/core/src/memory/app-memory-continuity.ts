import { getLastSessionContinuityInjectionStatus } from '../application/sessions/session-continuity-injection-status.js';
import { normalizeSubject } from './app-memory-boundaries.js';
import type {
  AppMemoryItem,
  MemoryBoundaryContext,
  MemoryReviewRecord,
  MemorySubjectType,
} from './memory-types.js';
type ContinuityMemoryPort = {
  dreamingStatus(input?: ContinuityInput): Promise<ContinuityRun[]>;
  listPendingReviews(input?: ContinuityInput): Promise<MemoryReviewRecord[]>;
  list(
    input?: Partial<MemoryBoundaryContext> & { limit?: number },
  ): Promise<AppMemoryItem[]>;
};
type ContinuityInput = Partial<MemoryBoundaryContext> & {
  subjectType?: MemorySubjectType;
  subjectId?: string;
};
type ContinuityRun = {
  completedAt?: string | null;
  startedAt: string;
  status: string;
  phase: string;
  summary: unknown;
};
export async function buildAppMemoryContinuityStatus(
  memory: ContinuityMemoryPort,
  input: Partial<MemoryBoundaryContext> = {},
) {
  const subject = normalizeSubject(input);
  const [runs, reviews] = await Promise.all([
    memory.dreamingStatus(subject),
    memory.listPendingReviews(subject),
  ]);
  return statusFromParts(subject, runs, reviews.length);
}
export async function buildAppMemoryContinuitySummary(
  memory: ContinuityMemoryPort,
  input: Partial<MemoryBoundaryContext> = {},
) {
  const subject = normalizeSubject(input);
  const [memories, runs, reviews] = await Promise.all([
    memory.list({ ...subject, limit: 100 }),
    memory.dreamingStatus(subject),
    memory.listPendingReviews(subject),
  ]);
  const status = statusFromParts(subject, runs, reviews.length);
  const injected = injectedStatus(subject);
  const recentDecisions = memories
    .filter((item) => item.kind === 'decision')
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      key: item.key,
      value: item.value,
      updated_at: item.updatedAt,
    }));
  const latestDreamSummary = summaryObject(runs[0]?.summary);
  const lastRun = runs[0];
  return {
    subject,
    active_count: memories.length,
    staged_count: status.stagedCount,
    promoted_count: status.promotedCount,
    needs_review_count: status.needsReviewCount,
    last_injected_block: status.lastInjectedBlock,
    last_dream_run: status.lastDreamRun,
    sections: {
      recent_decisions: section(
        recentDecisions.length > 0 ? 'populated' : 'empty',
        recentDecisions,
      ),
      active_paused_jobs: sectionFromInjected(
        injected?.sections.active_paused_jobs,
      ),
      last_runs: sectionFromInjected(
        injected?.sections.recent_session_digests,
        'No session digest loader was available for this subject.',
      ),
      last_dream_summary: section(
        lastRun && latestDreamSummary ? 'populated' : 'empty',
        lastRun && latestDreamSummary
          ? [
              {
                at: lastRun.completedAt || lastRun.startedAt,
                status: lastRun.status,
                phase: lastRun.phase,
                summary: latestDreamSummary,
              },
            ]
          : [],
      ),
      issue_index: section(
        'deferred',
        [],
        'No issue index repository is wired into memory continuity.',
      ),
    },
  };
}
function statusFromParts(
  subject: ReturnType<typeof normalizeSubject>,
  runs: ContinuityRun[],
  reviewCount: number,
) {
  const latestRun = runs[0];
  const summary = summaryObject(latestRun?.summary) ?? {};
  const injected = injectedStatus(subject);
  return {
    subject,
    stagedCount: Number(summary.staged ?? summary.stageCandidate ?? 0),
    promotedCount: Number(summary.promoted ?? 0),
    needsReviewCount: reviewCount || Number(summary.needsReview ?? 0),
    ...(injected
      ? {
          lastInjectedBlock: {
            subject: [
              injected.subject.appId,
              injected.subject.agentId,
              injected.subject.conversationId,
              injected.subject.threadId,
            ]
              .filter(Boolean)
              .join(':'),
            bytes: injected.bytes,
            at: injected.injectedAt,
          },
        }
      : {}),
    lastDreamRun: latestRun
      ? {
          at: latestRun.completedAt || latestRun.startedAt,
          status: latestRun.status,
          phase: latestRun.phase,
          summary,
        }
      : undefined,
  };
}
function injectedStatus(subject: ReturnType<typeof normalizeSubject>) {
  return getLastSessionContinuityInjectionStatus({
    appId: subject.appId,
    agentId: subject.agentId,
    conversationId: subject.channelId,
    userId: subject.userId,
    threadId: subject.threadId,
  });
}
function summaryObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
function section(status: string, items: unknown[], reason?: string) {
  return { status, count: items.length, items, ...(reason ? { reason } : {}) };
}
function sectionFromInjected(
  source: { status: string; count: number; items?: unknown[] } | undefined,
  reason = 'No continuity jobs loader has injected data for this subject.',
) {
  return source
    ? {
        status: source.status,
        count: source.count,
        items: (source.items || []).slice(0, 8),
      }
    : section('unavailable', [], reason);
}
