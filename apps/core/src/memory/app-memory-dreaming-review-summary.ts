import { countPendingMemoryReviews } from './app-memory-review.js';

export const MEMORY_REVIEW_SUMMARY_STATEMENT_TIMEOUT_MS = 2_000;

type CountPendingReviewsInput = Parameters<typeof countPendingMemoryReviews>[0];

export async function safeCountPendingMemoryReviews(
  input: CountPendingReviewsInput & { signal?: AbortSignal },
): Promise<number | undefined> {
  try {
    input.signal?.throwIfAborted();
    const pendingReviews = await countPendingMemoryReviews({
      db: input.db,
      subject: input.subject,
      statementTimeoutMs:
        input.statementTimeoutMs ?? MEMORY_REVIEW_SUMMARY_STATEMENT_TIMEOUT_MS,
    });
    input.signal?.throwIfAborted();
    return pendingReviews;
  } catch {
    return undefined;
  }
}

export function withPendingReviews<T extends Record<string, unknown>>(
  summary: T,
  pendingReviews: number | undefined,
): T & { pendingReviews?: number } {
  if (pendingReviews === undefined) return summary;
  return { ...summary, pendingReviews };
}
