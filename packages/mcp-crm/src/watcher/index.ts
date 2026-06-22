import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { BoondiCrmEnv } from '../env.js';
import type { Logger } from '../logger.js';
import type { RecordsRepository } from '../db/records-repository.js';
import type { ExtractorLlm } from '../extractor/llm-client.js';
import type { BusinessRecord } from '../db/types.js';
import type { ExtractedOpportunity } from '../extractor/types.js';
import { extractOpportunities } from '../extractor/extract.js';
import { applyExtraction } from '../extractor/apply.js';
import {
  findNewDigests,
  advanceDigestCursor,
  type PendingDigest,
  type PendingDigestFilter,
} from './digest-source.js';
import {
  loadTranscript,
  phoneFromConversationId,
} from '../reconciler/gantry-source.js';

export interface WatcherDeps {
  env: BoondiCrmEnv;
  logger: Logger;
  pool: Pool;
  repo: RecordsRepository;
  llm: ExtractorLlm | null;
}

export interface DigestCycleStats {
  digests: number;
  extracted: number;
  created: number;
  updated: number;
  skipped: number;
}

export interface DigestCycleOptions extends PendingDigestFilter {
  apply?: boolean;
  trigger?: 'timer' | 'manual';
  // Per-conversation failure back-off (auto watcher path only; the manual path
  // omits it). Skips conversations inside their back-off window and records the
  // per-conversation outcome so a persistently soft-failing conversation is not
  // retried every poll.
  backoff?: ConversationBackoff;
  now?: () => number;
}

export interface ConversationBackoff {
  shouldSkip(conversationId: string, nowMs: number): boolean;
  recordFailure(conversationId: string, nowMs: number): void;
  recordSuccess(conversationId: string): void;
}

function conversationRef(conversationId: string): string {
  return crypto
    .createHash('sha256')
    .update(conversationId)
    .digest('hex')
    .slice(0, 12);
}

// One summary string per open opportunity, fed to the extractor's matching
// prompt. Single source: both the digest cycle and the manual path must show
// the model IDENTICAL summaries, or their match decisions drift apart.
function openOpportunitySummary(o: BusinessRecord): string {
  return `${o.status} ${o.intentCategory} ${o.occasion ?? ''} qty=${o.quantity ?? '?'}`.trim();
}

function summarizeRecord(
  action: 'created' | 'updated',
  record: BusinessRecord,
): Record<string, unknown> {
  return {
    action,
    id: record.id,
    status: record.status,
    intentCategory: record.intentCategory,
    buyerType: record.buyerType,
    quantity: record.quantity,
    score: record.score,
    band: record.band,
    needsReview: record.needsReview,
  };
}

function summarizeOpportunity(
  o: ExtractedOpportunity,
): Record<string, unknown> {
  return {
    action: o.match ? 'update_candidate' : 'create_candidate',
    match: o.match,
    isLead: o.isLead,
    intentCategory: o.intentCategory,
    buyerType: o.buyerType,
    quantity: o.quantity,
    locationScope: o.locationScope,
    customisation: o.customisation,
    confidence: o.confidence,
  };
}

export async function runDigestCycleOnce(
  deps: WatcherDeps,
  options: DigestCycleOptions = {},
): Promise<DigestCycleStats> {
  const stats: DigestCycleStats = {
    digests: 0,
    extracted: 0,
    created: 0,
    updated: 0,
    skipped: 0,
  };
  if (!deps.llm) return stats;
  const llm = deps.llm;
  const shouldApply = options.apply ?? true;
  // Batch size is settings-owned (no hardcoded default on this path); an explicit
  // options.limit (manual / dry-run) still wins.
  const batchSize =
    options.limit ?? deps.env.crmLeadQueryExtractionWatcher.batchSize;
  const pending = await findNewDigests(
    deps.pool,
    deps.env.gantrySchema,
    deps.env.reconcileAgentId,
    {
      conversationId: options.conversationId,
      since: options.since,
      limit: batchSize,
    },
  );
  stats.digests = pending.length;
  if (pending.length > 0) {
    deps.logger.info(
      {
        digests: pending.length,
        agentId: deps.env.reconcileAgentId,
        trigger: options.trigger ?? 'timer',
        apply: shouldApply,
      },
      'digest_cycle_started',
    );
  }
  // Group the pending digests by conversation, preserving findNewDigests'
  // oldest-first (created_at ASC) order, then extract DISTINCT customers in
  // PARALLEL (bounded by max_parallel_extractions — mirrors the memory idle
  // sweep). Within each conversation we drain oldest-first and STOP at the first
  // digest that does not fully succeed: the cursor only advances over a gap-free
  // prefix, so a soft-failed digest (and everything after it in that conversation)
  // is retried next cycle. Distinct conversations are independent (separate cursor
  // rows), so a stop or back-off in one never blocks another.
  const maxParallel =
    deps.env.crmLeadQueryExtractionWatcher.maxParallelExtractions || 1;
  const nowMs = (options.now ?? (() => Date.now()))();
  const groups = [...groupDigestsByConversation(pending).entries()];
  await mapWithConcurrency(
    groups,
    maxParallel,
    async ([conversationId, digests]) => {
      if (options.backoff?.shouldSkip(conversationId, nowMs)) return;
      let drainedClean = true;
      for (const d of digests) {
        const advanced = await processDigest(deps, llm, d, shouldApply, stats);
        if (!advanced) {
          drainedClean = false;
          break;
        }
      }
      if (options.backoff) {
        if (drainedClean) options.backoff.recordSuccess(conversationId);
        else options.backoff.recordFailure(conversationId, nowMs);
      }
    },
  );
  return stats;
}

// Run `fn` over `items` with at most `limit` invocations in flight at once (a
// fixed pool of workers pulls the next item). Mirrors the memory idle sweep's
// bounded parallelism: peak concurrency = min(limit, items.length), never
// sequential-only and never unbounded.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const workers = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

// Per-conversation failure back-off (in-memory; cleared on success or restart).
// Mirrors the memory idle sweep: a conversation whose extraction keeps soft-
// failing must not be retried every poll forever (it would burn LLM calls), so it
// backs off exponentially. Phase 1's stop-at-gap keeps the failed digest eligible;
// this just paces the retries.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export function createConversationBackoff(): ConversationBackoff {
  const state = new Map<string, { failures: number; nextEligibleAt: number }>();
  return {
    shouldSkip(conversationId, nowMs) {
      const prior = state.get(conversationId);
      return prior !== undefined && nowMs < prior.nextEligibleAt;
    },
    recordFailure(conversationId, nowMs) {
      const failures = (state.get(conversationId)?.failures ?? 0) + 1;
      const delay = Math.min(
        BACKOFF_BASE_MS * 2 ** (failures - 1),
        BACKOFF_MAX_MS,
      );
      state.set(conversationId, { failures, nextEligibleAt: nowMs + delay });
    },
    recordSuccess(conversationId) {
      state.delete(conversationId);
    },
  };
}

function groupDigestsByConversation(
  pending: PendingDigest[],
): Map<string, PendingDigest[]> {
  const groups = new Map<string, PendingDigest[]>();
  for (const d of pending) {
    const existing = groups.get(d.conversationId);
    if (existing) existing.push(d);
    else groups.set(d.conversationId, [d]);
  }
  return groups;
}

// Process exactly one digest. Returns true only when the conversation may safely
// advance to the NEXT digest — i.e. this one fully succeeded (extracted, and when
// applying, applied + cursor advanced; in dry-run, extracted). A false return is a
// soft fail (unsupported conversation id, extractor parse failure, or an
// unexpected error): the caller stops the conversation here so the cursor never
// moves past an unprocessed digest, and that digest is retried next cycle.
async function processDigest(
  deps: WatcherDeps,
  llm: ExtractorLlm,
  d: PendingDigest,
  shouldApply: boolean,
  stats: DigestCycleStats,
): Promise<boolean> {
  const ref = conversationRef(d.conversationId);
  const phone = phoneFromConversationId(d.conversationId);
  if (!phone) {
    stats.skipped += 1;
    deps.logger.warn(
      {
        digestId: d.digestId,
        conversationRef: ref,
        reason: 'unsupported_conversation_id',
      },
      'digest_skipped',
    );
    return false;
  }
  try {
    const transcript = await loadTranscript(
      deps.pool,
      deps.env.gantrySchema,
      d.conversationId,
    );
    const open = await deps.repo.getOpenOpportunitiesByPhone(phone);
    deps.logger.info(
      {
        digestId: d.digestId,
        digestAt: d.digestAt,
        conversationRef: ref,
        transcriptMessages: transcript.length,
        openOpportunities: open.length,
      },
      'digest_process_started',
    );
    const result = await extractOpportunities(
      llm,
      {
        conversationId: d.conversationId,
        phone,
        transcript,
        digestText: d.digestText,
        openOpportunities: open.map((o) => ({
          id: o.id,
          summary: openOpportunitySummary(o),
        })),
      },
      (detail) =>
        deps.logger.warn(
          {
            digestId: d.digestId,
            conversationRef: ref,
            reason: detail.reason,
            rawHead: detail.rawHead,
          },
          'extraction_parse_failed',
        ),
    );
    if (!result) {
      stats.skipped += 1;
      deps.logger.warn(
        {
          digestId: d.digestId,
          conversationRef: ref,
          reason: 'extractor_parse_failed',
        },
        'digest_skipped',
      );
      return false;
    }
    stats.extracted += result.opportunities.length;
    if (!shouldApply) {
      deps.logger.info(
        {
          digestId: d.digestId,
          conversationRef: ref,
          extracted: result.opportunities.length,
          output: result.opportunities.map(summarizeOpportunity),
        },
        'digest_process_completed',
      );
      return true;
    }
    const applied = await applyExtraction(deps.repo, {
      phone,
      conversationId: d.conversationId,
      opportunities: result.opportunities,
    });
    stats.created += applied.created;
    stats.updated += applied.updated;
    await advanceDigestCursor(
      deps.pool,
      d.conversationId,
      d.digestId,
      d.digestAt,
    );
    deps.logger.info(
      {
        digestId: d.digestId,
        conversationRef: ref,
        extracted: result.opportunities.length,
        created: applied.created,
        updated: applied.updated,
        output: applied.records.map(({ action, record }) =>
          summarizeRecord(action, record),
        ),
      },
      'digest_process_completed',
    );
    return true;
  } catch (err) {
    stats.skipped += 1;
    deps.logger.warn(
      {
        digestId: d.digestId,
        conversationRef: ref,
        err: err instanceof Error ? err.message : String(err),
      },
      'digest_process_failed',
    );
    return false;
  }
}

export type ManualExtractionStats = DigestCycleStats;

// Manual extraction accepts exactly one WhatsApp conversation.
const MANUAL_CONVERSATION_ID_RE = /^conversation:wa:\d+$/;

/**
 * Operator-triggered extraction for ONE conversation using the same digest-based
 * path as the automatic watcher. If no pending digest exists, it is a no-op.
 */
export async function runManualConversationExtraction(
  deps: WatcherDeps,
  conversationId: string,
): Promise<ManualExtractionStats> {
  if (!MANUAL_CONVERSATION_ID_RE.test(conversationId)) {
    throw new Error(
      'manual extraction requires a conversation:wa:<digits> conversationId',
    );
  }
  return runDigestCycleOnce(deps, { conversationId, trigger: 'manual' });
}

// Single-flight across mcp-crm instances: only one digest cycle runs at a time. A
// session-level advisory lock (held on a dedicated connection for the whole cycle)
// stops two pollers — e.g. an orphaned second `npm run dev` on the same Postgres —
// from double-extracting and burning duplicate LLM calls. Correctness is already
// idempotent (upsert + monotonic cursor); this just avoids the waste. Mirrors the
// memory idle sweep's single-flight lease. The lease connection is separate from
// the parallel extraction lanes, which is why db_pool_size must be >=
// max_parallel_extractions + 1.
const DIGEST_WATCHER_LEASE_KEY = 0x426f6e64; // stable 32-bit advisory key ("Bond")

async function withDigestWatcherLease<T>(
  pool: Pool,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const client = await pool.connect();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [DIGEST_WATCHER_LEASE_KEY],
    );
    locked = res.rows[0]?.locked === true;
    if (!locked) return undefined; // another instance holds the single-flight lease
    return await fn();
  } finally {
    if (locked) {
      await client
        .query('SELECT pg_advisory_unlock($1)', [DIGEST_WATCHER_LEASE_KEY])
        .catch(() => undefined);
    }
    client.release();
  }
}

export function startDigestWatcher(deps: WatcherDeps): () => void {
  if (!deps.env.crmLeadQueryExtractionWatcher.enabled) {
    deps.logger.info({}, 'digest_watcher_disabled');
    return () => undefined;
  }
  if (!deps.llm) {
    deps.logger.warn({}, 'extractor_disabled_no_key');
    return () => undefined;
  }
  let running = false;
  let stopped = false;
  // One back-off instance per watcher process, shared across cycles.
  const backoff = createConversationBackoff();
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const stats = await withDigestWatcherLease(deps.pool, () =>
        runDigestCycleOnce(deps, { backoff }),
      );
      if (stats && stats.digests > 0) {
        deps.logger.info({ ...stats }, 'digest_cycle');
      }
    } catch (err) {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'digest_cycle_failed',
      );
    } finally {
      running = false;
    }
  };
  deps.logger.info(
    {
      intervalMs: deps.env.crmLeadQueryExtractionWatcher.pollIntervalMs,
      model: deps.env.crmLeadQueryExtractionWatcher.model,
      maxParallelExtractions:
        deps.env.crmLeadQueryExtractionWatcher.maxParallelExtractions,
      batchSize: deps.env.crmLeadQueryExtractionWatcher.batchSize,
    },
    'digest_watcher_started',
  );
  const handle = setInterval(
    () => void tick(),
    deps.env.crmLeadQueryExtractionWatcher.pollIntervalMs,
  );
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
