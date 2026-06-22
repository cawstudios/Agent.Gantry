# Scale-Out & AWS-Readiness Plan

Recast to `agents/boondi_support/docs/plan-guiding-template.md`. Code and live runtime behavior are the source of truth; this file is a reference, not proof.

**Builds on** `revised-scaling-architecture-plan.md` — **fully implemented and verified on the live dev server** (all of Phases 0–4: two-knob worker model, background isolation, digest bookmark fix, cleanup; code not yet committed, worker numbers not yet load-tuned). This plan = the **not-yet-done scale-out layer**; anything that plan implemented is excluded here.

**Standing principles** (inherited): Config = SOT (every knob in `settings.yaml`, secrets in `.env`); No legacy traces; Proof on the live dev server with real evidence; **Minimum footprint** (≈2 instances, fewest LLM calls, deterministic evidence) — token-constrained; real load-testing deferred.

---

## 1. Goal

- **In scope (doable now, no AWS):** load-aware claim (capacity-gated, so scaling out actually balances); ingestion durability (persist-before-ACK); message idempotency hardened to a DB constraint; autoscaling **hooks** (emit scaling metrics; cordon flag; verify graceful drain; background-only run mode); prove it all with **2 local instances on one Postgres**.
- **In scope (design only, execute on AWS access):** ALB + ASG + CloudWatch scaling policy; API Gateway→SQS (true-zero-loss ingestion); RDS + PgBouncer; dedicated background tier; production load-test.
- **Out of scope:** anything `revised-scaling-architecture-plan.md` already did; rewriting the lease/NOTIFY model (we extend it, not replace it).
- **Success means:** N cores on shared Postgres **balance load** (no hoarding), **scale-in drains to zero cleanly**, scaling **metrics are emitted** for an ASG to consume, **no customer message lost** on a mid-ingest crash — all provable **locally with 2 instances**, leaving AWS as *provisioning + tuning, not a rewrite*.
- **Non-goals:** production worker numbers (load-test, deferred); predictive/scheduled scaling tuning (AWS-phase).

## 2. Current Evidence

- **Code (verified):** multi-instance is already lease-safe (atomic claim) but **claim is first-to-grab, not load-aware** → a busy core still claims and parks work in its in-memory queue while a peer idles ([conversation-work-dispatcher.ts:60](apps/core/src/runtime/conversation-work-dispatcher.ts)). Reconciler already recovers expired-lease + never-claimed work. Webhook **ACKs before it persists** ([interakt-webhook.ts:61](apps/core/src/control/server/routes/interakt-webhook.ts)). Message store **dedupes** (`storeMessage` → `duplicate_existing_message`, pipeline skips) ([channel-persistence-handlers.ts:364](apps/core/src/app/bootstrap/channel-persistence-handlers.ts)). Runtime **already computes** busy/total/pending (`getWorkerInventorySnapshot`, [worker-inventory-snapshot.ts](apps/core/src/runtime/worker-inventory-snapshot.ts)). Graceful drain (lease-draining on shutdown + `shutdown_claim_wait_ms`) exists.
- **Not yet proven / not built:** whether the message dedup is a **DB unique constraint** (vs app-level check — not found in schema grep); a **cordon** ("stop claiming, stay up") flag; a **background-only run mode** (prior plan called it "mostly a switch," unverified).
- **External constraint:** Interakt = **no inbound retry**, 3s ACK, 5-fails-in-10min disables the webhook (confirmed via docs) → in-DB durability can't be absolute; true-zero-loss needs a managed buffer (SQS).
- **Open questions:** capacity-gated claim vs. a full `SELECT … FOR UPDATE SKIP LOCKED` pull-queue rewrite (start with the former).

## 3. Source of Truth

- **Code** = truth. **Live dev-server (2 instances on one Postgres)** = acceptance proof for distribution/drain. **`settings.yaml`** = config truth (thresholds explicit). AWS infra config (later) lives in IaC, not this repo.

## 4. Ownership Boundary

- **Gantry runtime owns:** the *claim decision* (capacity-gated), lease/heartbeat/reconciler, cordon flag, run-mode flag, and **emitting** scaling metrics.
- **AWS owns (later):** ALB, ASG + scaling policies, CloudWatch alarms, SQS, RDS/PgBouncer — they *consume* what the runtime emits and *call* the cordon hook.
- **Config owns:** scaling thresholds (utilization target, min floor) live in `settings.yaml`/env; **secrets in `.env`**.
- **Must not be duplicated:** one capacity number (`total_workers`) drives both the run-gate and the claim decision; no second "is-this-core-full" source.

## 5. Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | capacity-gated claim; persist-before-ACK; cordon |
| Conversation-work dispatcher | Changed | check free capacity before claiming |
| Webhook route | Changed | persist (deduped) → then ACK |
| Postgres schema | Changed | unique index on provider message id (idempotency) |
| Metrics surface | **Added** | emit busy/total/pending for CloudWatch |
| Runtime flags | **Added** | `cordon` + `background-only` run mode |
| `settings.yaml` | Changed | autoscale thresholds (utilization target, min floor) |
| Channel/provider adapters | Unchanged by design | ingress path only reordered, not restructured |
| AWS infra (ALB/ASG/SQS/RDS) | **New, external** | provisioned in IaC, not this repo |
| Tests/verification | Changed | 2-instance distribution + drain + crash proofs |

## 6. Phase Plan

> Same discipline: *smallest safe change → focused live proof (2 instances, minimum footprint) → remove any dead path*. Update Status + §8 evidence after each phase.

### Phase A: Multi-instance correctness — idempotency + load-aware claim *(the linchpin)*
- **Status:** Not started
- **Objective:** (a) make message dedup a **DB unique constraint** on provider message id (race-proof under concurrent at-least-once); (b) **capacity-gated claim** — a core claims only if `activeRuns < total_workers`; if full, it doesn't claim, leaving the lease for a freer peer / the reconciler. "First-to-grab" → "first *free* to grab."
- **Changes allowed:** dispatcher claim path; `messages` schema (unique index); nothing else.
- **Evidence required:** **2 cores on one Postgres** — send a small burst; work **spreads to the idle core** (not hoarded); no double-processing; leases distribute. Deterministic via logs + lease rows; ~minimal LLM calls.
- **Regression risk:** medium (claim path) → 2-instance proof mandatory. *(Future refinement, not now: replace NOTIFY-broadcast with `FOR UPDATE SKIP LOCKED` pull-queue.)*
- **Reviewer decision:** —

### Phase B: Ingestion durability — persist before ACK
- **Status:** Not started *(locked in the prior plan's §1 scope; implemented here)*
- **Objective:** reorder the webhook route to **verify sig → `storeMessage` (deduped) → ACK → process**. Only the persist moves before the ACK; heavy work stays after. Depends on Phase A's unique constraint so a duplicate/redrive is a safe no-op.
- **Changes allowed:** `interakt-webhook.ts` ordering only.
- **Evidence required:** ACK still lands well under 3s (measure); a message received-then-core-killed-pre-process is recovered (persisted + reconciler) rather than lost.
- **Regression risk:** medium (3s SLA) → measure ACK latency.
- **Reviewer decision:** —

### Phase C: Autoscaling hooks — make it AWS-consumable
- **Status:** Not started
- **Objective:** (1) **emit** busy/total/pending (`getWorkerInventorySnapshot`) in a CloudWatch-consumable form (metrics endpoint or structured periodic log); (2) **cordon** flag — a signal that stops a core claiming new work while it finishes current chats; (3) **verify graceful drain** (lease-draining + reconciler) on a local shutdown; (4) **background-only run mode** flag (runs sweeps/jobs, serves no customer webhooks/claims).
- **Changes allowed:** metrics emission, two runtime flags, drain verification.
- **Evidence required:** local — cordon a core → it stops taking new chats and **drains to 0**, peer absorbs them; metrics visible; a background-only process serves no webhooks.
- **Regression risk:** low–medium.
- **Reviewer decision:** —

### Phase D: AWS support — provision + tune *(deferred; needs AWS access)*
- **Status:** Deferred (design captured; execute on AWS access — Phases A–C make this *config, not code*)
- **Objective:** ALB (webhook ingress) → **ASG** with **target-tracking on utilization (~60%) + scheduled scaling** for known peaks (queue depth = emergency alarm; **never CPU**), min floor ≥2, lifecycle hooks calling the **cordon** (Phase C) on scale-in; **API Gateway→SQS** for true-zero-loss ingestion (upgrade over Phase B); **RDS + PgBouncer**, reconciler/NOTIFY cadence tuned to instance count; **dedicated background tier** (own ASG, scaled on backlog, dedicated token) using Phase C's run mode; **production load-test** to set `total_workers`/`warm_reserve_workers`/`max_parallel_extractions` + ASG thresholds; SLO dashboards/alerts.
- **Evidence required:** (AWS-phase) burst test scales out before queueing; scale-in drains with zero dropped chats; SQS redelivers on a killed instance.
- **Regression risk:** managed externally.
- **Reviewer decision:** —

## 7. Testing Strategy

Inherited discipline: **focused live proof at minimum footprint, no full regression, token-constrained.**
- **Static/code:** typecheck; unit tests for the capacity-gate decision + the persist-before-ACK ordering; migration test for the unique index.
- **Multi-instance (the key proof):** run **2 cores against one Postgres locally** — distribution, no double-processing, cordon-drain-to-zero. Cheap (mostly deterministic; a couple of LLM calls).
- **Crash proof:** kill a core mid-ingest / mid-run → reconciler recovers; no loss (within the persist-before-ACK guarantee).
- **No** production-scale load test (Phase D, deferred). Cap parallel live tests to avoid rate-limit collisions.

## 8. Live Acceptance Criteria

| Scenario | Runtime evidence | Log/DB evidence | Decision |
| --- | --- | --- | --- |
| Load-aware: busy core doesn't hoard | 2-instance run; work lands on the idle core | dispatcher skips claim when `activeRuns = total_workers`; lease owner = idle core | — |
| Idempotency under concurrency | concurrent duplicate → one row | DB unique violation → `onConflictDoNothing` | — |
| Ingestion durability | core killed pre-process → message present + reprocessed | message row persisted before ACK; ACK < 3s measured | — |
| Cordon → drain to zero | cordoned core takes no new chats, reaches 0 busy | claim-skipped logs; peer absorbs | — |
| Metrics emitted | busy/total/pending visible | CloudWatch-shaped metric/log present | — |
| Background-only mode | process runs sweeps, no webhook serve | 0 webhook/claim activity on that process | — |

Guards: no internal/process leakage; no double-reply; no broad MCP fanout.

## 9. Token, Cost & Rate-Limit Discipline

- 2-instance local proofs are **deterministic-first** (logs/lease rows/process counts) — spend LLM calls only to confirm an actual reply path. Reuse evidence; no per-edit live suites.
- Defer the production load-test (Phase D). Keep `max_parallel_extractions` / worker numbers low until then.

## 10. Rollback & Cleanup

- Each phase is an independent, revertible slice (`git revert`), no commit/stage unless asked.
- No legacy traces: the capacity gate reuses `total_workers` (no new "is-full" source); persist-before-ACK replaces the post-ACK persist (no dual path).
- If Phase A adds a unique index, ship its migration with the dedup code in the same slice.
- Stale-reference grep after each slice = 0.

## 11. Self-Review

- **Simplest correct architecture?** Yes — extend the existing lease/NOTIFY model with a capacity check; defer the `SKIP LOCKED` rewrite.
- **Ownership clean?** Yes — runtime *emits + decides*; AWS *consumes + provisions*.
- **Workaround disguised as design?** No — capacity-gated claim is the real fix; SQS noted as the true-zero-loss upgrade, not faked in-DB.
- **Duplicate source of truth?** No — one capacity number drives gate + claim.
- **Live proof strong enough?** Yes — 2-instance local proof for the load-aware/drain claims; crash proof for durability.
- **Fix one, break another?** Claim-path change (Phase A) + 3s SLA (Phase B) are the risks → both have explicit live measurements.
- **Token/cost justified?** Yes — deterministic-first, load-test deferred.
- **Cleanup explicit?** Yes — §10.

## 12. Final Reviewer Decision

- **Approved:** —
- **Approved with changes:** —
- **Blocked:** —
- **Reason:** awaiting operator review.
- **Next action:** on approval, start **Phase A** (idempotency constraint + capacity-gated claim) and prove it with **2 local instances** — the linchpin that makes horizontal scale real before any AWS provisioning.
