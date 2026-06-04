import type { Pool } from 'pg';
import type { BoondiCrmEnv } from '../env.js';
import type { Logger } from '../logger.js';
import type { RecordsRepository } from '../db/records-repository.js';
import { classifyTranscript } from './classify.js';
import {
  advanceCursor,
  findReconcileCandidates,
  getCursor,
  loadTranscript,
} from './gantry-source.js';

export interface ReconcilerDeps {
  env: BoondiCrmEnv;
  logger: Logger;
  pool: Pool;
  repo: RecordsRepository;
}

export interface ReconcileCycleStats {
  candidates: number;
  skippedNoNewActivity: number; // cursor already at this state
  skippedAlreadyCaptured: number; // fast path already has an open record
  reconstructed: number; // a query was created from the transcript
  noSignal: number; // idle chat with no business intent
}

// One pass of the durable backstop. Exported so it can be unit/integration tested
// and triggered on demand. Pure orchestration over the read-only Gantry source,
// the heuristic classifier, and the records repository.
//
// The no-loss guarantee: every business signal lives in Gantry's durable
// transcript regardless of whether this connector was up. This pass reconstructs
// a QUERY for any concluded conversation that has commercial intent but no record
// (the fast path missed it / the connector was down). It is cost-safe: it only
// does work when there are new messages (cursor) AND no record already exists.
export async function runReconcileCycleOnce(
  deps: ReconcilerDeps,
): Promise<ReconcileCycleStats> {
  const stats: ReconcileCycleStats = {
    candidates: 0,
    skippedNoNewActivity: 0,
    skippedAlreadyCaptured: 0,
    reconstructed: 0,
    noSignal: 0,
  };
  const candidates = await findReconcileCandidates(deps.pool, {
    idleMinutes: deps.env.reconcileIdleMinutes,
    lookbackHours: deps.env.reconcileLookbackHours,
  });
  stats.candidates = candidates.length;

  for (const candidate of candidates) {
    // (1) Already processed this exact state? No new messages since last check.
    const cursor = await getCursor(deps.pool, candidate.conversationId);
    if (cursor && cursor.lastMessageId === candidate.lastMessageId) {
      stats.skippedNoNewActivity += 1;
      continue;
    }

    // (2) Does the customer already have an open record? Then the fast path (or a
    // prior pass) captured the signal — never clobber the precise agent record
    // with heuristic data. Just advance the cursor so we don't re-check it.
    const existing = await deps.repo.getOpenRecordByPhone(candidate.phone);
    if (existing) {
      stats.skippedAlreadyCaptured += 1;
      await advanceCursor(
        deps.pool,
        candidate.conversationId,
        candidate.lastMessageId,
        candidate.lastActivityAt,
      );
      continue;
    }

    // (3) No record — reconstruct from the durable transcript.
    const transcript = await loadTranscript(deps.pool, candidate.conversationId);
    const result = classifyTranscript(transcript);
    if (result) {
      await deps.repo.recordQuery(candidate.phone, result.input, 'reconciler');
      stats.reconstructed += 1;
      deps.logger.info(
        {
          conversationId: candidate.conversationId,
          phone: candidate.phone,
          intentCategory: result.input.intentCategory,
        },
        'boondi_crm_reconciler_reconstructed_query',
      );
    } else {
      stats.noSignal += 1;
    }
    await advanceCursor(
      deps.pool,
      candidate.conversationId,
      candidate.lastMessageId,
      candidate.lastActivityAt,
    );
  }
  return stats;
}

// Start the durable backstop: an immediate catch-up pass (so a restart recovers
// anything missed while the connector was down), then a periodic pass. A pass is
// never allowed to overlap itself, and a pass failure is logged but never crashes
// the connector (the customer chat is already insulated from capture failures).
export function startReconciler(deps: ReconcilerDeps): () => void {
  if (!deps.env.reconcileEnabled) {
    deps.logger.info({}, 'boondi_crm_reconciler_disabled');
    return () => undefined;
  }

  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const stats = await runReconcileCycleOnce(deps);
      if (stats.candidates > 0) {
        deps.logger.info({ ...stats }, 'boondi_crm_reconciler_cycle');
      }
    } catch (err) {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'boondi_crm_reconciler_cycle_failed',
      );
    } finally {
      running = false;
    }
  };

  deps.logger.info(
    {
      intervalMs: deps.env.reconcileIntervalMs,
      idleMinutes: deps.env.reconcileIdleMinutes,
      lookbackHours: deps.env.reconcileLookbackHours,
    },
    'boondi_crm_reconciler_started',
  );
  void tick(); // immediate catch-up on boot
  const timer = setInterval(() => void tick(), deps.env.reconcileIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
