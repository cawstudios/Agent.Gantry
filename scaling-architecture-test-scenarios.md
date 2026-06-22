# Scaling Architecture — Test Scenarios

Companion to `revised-scaling-architecture-plan.md`. Every scenario below maps to a
real code path and lists **observable evidence** (log line / process count / DB row /
reply) so you can verify it deterministically. Status: ✅ already proven during
implementation · ⬜ open (to test).

Token discipline: most scenarios are provable from **logs / process count / DB rows**
with **0–3 LLM calls**. Prefer the deterministic checks; only the "real reply" rows
spend tokens.

---

## 0. Test harness (how to drive everything)

**Settings** live in `~/gantry/settings.yaml` (symlink → `agents/boondi_support/settings.yaml`).
Edit a knob → **restart core** to apply (settings are boot-parsed; some are re-read live).

```bash
WT=/Users/caw-d/Desktop/gantry/.claude/worktrees/pillar-1-event-ipc-transport
# NOTE: this shell is zsh. An unquoted `$VAR` does NOT word-split in zsh, so the
# old `STRIP="env -u ..."` + `$STRIP npm run dev` idiom fails with
# `command not found: env -u ...` (core never starts). Use a function instead —
# it word-splits correctly in both zsh and bash:
strip() { env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_OAUTH_TOKEN "$@"; }

# Restart CORE (live worker model)
pkill -f "apps/core/src/index.ts"; lsof -ti tcp:4710 -sTCP:LISTEN | xargs kill -9 2>/dev/null
( cd "$WT" && strip npm run dev > /tmp/gantry-core-dev.log 2>&1 & )

# Restart MCP-CRM (CRM extractor)
pkill -f "packages/mcp-crm/src/index.ts"; lsof -ti tcp:8082 -sTCP:LISTEN | xargs kill -9 2>/dev/null
( cd "$WT/packages/mcp-crm" && strip npm run dev > /tmp/mcp-crm-dev.log 2>&1 & )
```

**Send a customer turn** (signed webhook — full detail in `agents/boondi_support/docs/BOONDI-E2E-TESTING.md` §4). Use `000*` fake numbers under `GANTRY_OUTBOUND_DRYRUN=1`:

```bash
SECRET=$(grep '^INTERAKT_WEBHOOK_SECRET=' ~/gantry/.env | cut -d= -f2-)
send() { NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000000); MID=$(uuidgen|tr A-Z a-z)
  B='{"version":"1.0","timestamp":"'$NOW'","type":"message_received","data":{"customer":{"channel_phone_number":"'$1'","traits":{"name":"T'$1'"}},"message":{"id":"'$MID'","chat_message_type":"CustomerMessage","message_content_type":"Text","message":"'$2'","received_at_utc":"'$NOW'"}}}'
  S=$(printf '%s' "$B"|openssl dgst -sha256 -hmac "$SECRET"|awk '{print $NF}')
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4710/v1/channels/interakt/webhook -H "Content-Type: application/json" -H "Interakt-Signature: sha256=$S" --data-binary "$B"; }
# send 000000901 "do you have kaju katli?"
```

**Observe:**

| Want | Command |
| --- | --- |
| Runner process count | `pgrep -f "runner/index.ts" \| wc -l` |
| Warm vs run processes | `pgrep -af "runner/index.ts"` (warm = `gantry-warm-…`) |
| Concurrency / queue (debug) | restart core with `LOG_LEVEL=debug`; `grep -E "Starting agent run\|concurrency limit, message queued" /tmp/gantry-core-dev.log` |
| Warm pool | `grep -E "Warm pool prewarm (started\|ready)\|Warm worker acquired" /tmp/gantry-core-dev.log` |
| Reply text/latency | `curl -s "http://localhost:3000/api/messages?conversationId=conversation:wa:<num>"` |
| Guardrail / outbound flow | `grep -E "flow:guardrail\|flow:outbound" /tmp/gantry-core-dev.log` |
| CRM extractor | `grep -E "digest_watcher_started\|digest_cycle\|digest_process_(completed\|failed)\|digest_skipped" /tmp/mcp-crm-dev.log` |
| Memory sweep | `grep -E "Idle session memory extracted\|Digest and short-memory watcher" /tmp/gantry-core-dev.log` |
| DB (no psql on PATH) | use the admin API, or a `tsx` snippet like `packages/mcp-crm/scripts/_phase1_proof.ts` was |

**Knob cheat-sheet** (`~/gantry/settings.yaml`):
- `runtime.workers.total_workers` — max concurrent **active** chats (the gate). NOT a hard process ceiling — see "Capacity invariant" below.
- `runtime.workers.warm_reserve_workers` — warm-ready reserve (≤ total).
- `runtime.warm_pool.enabled` / `cache_prewarm_enabled` / `cache_prewarm_concurrency`; plus `idle_ttl_ms` (**optional** — defaults `240000`; not written in yaml unless you add it).
- `runtime.queue.max_job_runs` — scheduled-job concurrency (separate world).
- `runtime.runner.idle_timeout_ms` — how long a finished runner is retained idle-waiting (continuity).
- `memory.idle_sweep_concurrency` / `idle_sweep_extraction_timeout_ms` — digest+memory sweep.
- `mcp_servers."mcp:boondi-crm".crm_lead_query_extraction_watcher.{max_parallel_extractions,batch_size,db_pool_size,poll_interval_ms}`.
- `.env`: `GANTRY_BACKGROUND_ANTHROPIC_TOKEN` (token seam).

---

## Capacity invariant & gotchas (read before §1–§3)

- **`total_workers` caps concurrent _active_ runs — NOT total processes.** A finished run is **retained idle-waiting** for `runner.idle_timeout_ms` (worker continuity): going idle **frees its concurrency slot** but **keeps its process**. So **process count can briefly exceed `total_workers` by design** — e.g. at `total_workers:2` you can see 3 procs (2 active + 1 retained). Strict guarantees to test: **active runs ≤ `total_workers`**, and **warm-pool procs ≤ `warm_reserve_workers`** (the 2× overshoot bug is fixed). Total live procs ≈ active + retained-continuity runners (one per recently-active conversation, expiring after `idle_timeout_ms`) + warm-idle.
- **Two similarly-named "idle" knobs — don't confuse them:**
  - `warm_pool.idle_ttl_ms` → freshness TTL for an **unused, pre-booted** warm worker (recycle + re-prewarm). Optional; default `240000`.
  - `runner.idle_timeout_ms` → how long an **already-used** runner is retained for that customer's fast follow-up (continuity).
- **Optional knobs default when absent** from yaml (e.g. `idle_ttl_ms`). A scenario that lists such a knob means **add it** to test a non-default value.

---

## 1. Boot & warm reserve

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1 | Warm reserve prewarms at boot | `total_workers:3, warm_reserve_workers:3, warm_pool.enabled:true` | restart core | `Warm pool prewarm ready … size:3`; idle runner count == 3 | P0 | ✅ |
| 1.2 | Idle footprint == reserve (not total) | `total_workers:5, warm_reserve_workers:2` | restart, idle | idle runner count == 2 (not 5) | P0 | ✅ |
| 1.3 | Warm pool disabled | `warm_pool.enabled:false` | restart, idle | 0 warm runners at idle; first chat cold-spawns + still replies | P1 | ✅ |
| 1.4 | Zero reserve | `warm_reserve_workers:0` | restart, idle | 0 idle warm; chats cold-spawn up to `total_workers` | P1 | ✅ |
| 1.5 | Cache prewarm on | `cache_prewarm_enabled:true` | restart | `Provider cache prewarm succeeded` before `prewarm ready` | P2 | ✅ |

## 2. Concurrency & the gate (`total_workers`)

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 2.1 | N run, N+1 waits | `total_workers:2` (debug log) | send 3 webhooks to 3 distinct numbers fast | 2× `Starting agent run` (activeMessageCount 1,2); 1× `concurrency limit, message queued`; queued one runs when a slot frees; all 3 reply | P0 | ✅ |
| 2.2 | No 2× process overshoot under load | `total_workers:2, warm_reserve_workers:2` | drive 2 concurrent | warm processes stay 2 (old bug → 4); no `Warm pool prewarm started` booting beyond reserve mid-burst | P0 | ✅ |
| 2.3 | Dial up | `total_workers:2→5` | edit + restart; send 6 | 5 run concurrently, 6th waits (queuedΔ=1) | P1 | ✅ |
| 2.4 | Dial down | `total_workers:5→1` | edit + restart; send 2 | only 1 runs, 2nd waits (queuedΔ=1) | P1 | ✅ |
| 2.5 | Same conversation, rapid msgs | 1 number, 3 msgs fast | — | they serialize on ONE queue key (not 3 slots); no slot waste | P1 | ✅ |

## 3. Warm pool internals (acquire / recycle / cold spawn)

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 3.1 | Acquire → bind → release → refill | reserve:3 | send 1 chat; force RELEASE (retention ends — lower `runner.idle_timeout_ms`, or send `/new`) | `Warm worker acquired; binding`; **during run** 2 idle + 1 active (not 3 idle + 1 — that'd be the overshoot bug); **after the runner releases** (not just after the reply — it's retained for `idle_timeout_ms`), pool recycles + refills back to 3 idle | P0 | ✅ |
| 3.2 | Cold spawn beyond reserve | `total_workers:4, warm_reserve_workers:2` | send 4 concurrent | 2 warm-acquired + 2 cold-spawned; total processes ≤ 4; all reply | P0 | ✅ |
| 3.3 | Idle TTL eviction | `warm_pool.idle_ttl_ms: 8000` (maintenance tick = ttl/4 clamped [1s,60s]), reserve:2 | leave warm workers idle > ttl | idle warm workers recycled then re-prewarmed (watch warm-pool maintenance) | P2 | ✅ |
| 3.4 | Overshoot math (unit-equivalent live) | reserve:2 | acquire both, hold, observe | `idle + active ≤ 2` at all times; 3rd acquire cold-spawns | P0 | ✅ (unit) |
| 3.5 | Health-check eviction | low `idle_ttl_ms` so maintenance ticks fast | `kill -9` a warm worker | unhealthy worker recycled + replaced (≈1 tick) | P2 | ✅ |

## 4. Worker continuity (retained idle-waiting runner)

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 4.1 | Fast follow-up reuses runner | `idle_timeout_ms:300000` | send msg → reply, then send 2nd msg within 5 min | 2nd msg continues on the SAME retained runner (no fresh `Spawning host agent`); faster reply; `resumed:true` in `flow:llm.input` | P0 | ✅ |
| 4.2 | Idle-drain frees a slot | `total_workers:2`; 2 convos active, one goes idle-waiting | send a 3rd convo msg | the idle-waiting run releases its active slot → 3rd starts via `reason:"drain"` while activeMessageCount stays ≤ 2 | P1 | ✅ (seen in 2.1) |
| 4.3 | Idle timeout → fresh start | `idle_timeout_ms:20000` | reply, wait > 20s, send again | retained runner exited; next msg cold/warm-starts fresh (`resumed:false`) | P1 | ✅ |
| 4.4 | Continuity survives reserve pressure | reserve:1, two convos | interleave msgs | each convo keeps continuity; no cross-talk between conversations | P2 | ✅ |

## 5. Worker death & recovery ("worker dies, user comes back")

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 5.1 | Runner killed mid-run | send a chat | `pkill -f runner/index.ts` during the run | run fails + is retried (scheduleRetry backoff) OR next inbound recovers; no crash of core | P0 | ✅ (retry+backoff logged, core stable; next inbound recovers ~6s. Note: kill mid-gen → empty reply, that one reply is dropped but convo recovers) |
| 5.2 | Core restart mid-conversation | active session | restart core | on reboot, persisted session resumes; customer's next msg continues context (session-resume) | P0 | ✅ (msg2 recalled "50 boxes / office Diwali" across a full core restart) |
| 5.3 | Customer returns after gap → context via memory block | reply, **wait for idle sweep to write digest+memory** (or seed it), kill runner | customer sends again | new run restores context from the injected **memory block** (digest+memory+CRM), not from SDK resume | P0 | ✅ **CORRECTED (by design)** — Gantry does **not** pass `resume` to Anthropic (confirmed: SDK args carry no resume field); cross-run context is restored via the memory block (session digest + extracted memory + CRM lead). So a worker death *before* any digest exists yields a legitimately empty memory block → no prior-turn recall — **expected, not a bug** (my earlier test killed the runner ~10s after msg1, before the 2-min idle sweep). **Directly proven:** msg1 (75 boxes) → `/digest-session` (digest written) → **killed all runners** → returning msg recalled *"75 boxes of Motichoor Ladoo for your office Diwali party"* via the memory block. Live within-window continuity = retained runner (**4.1** ✅). |
| 5.4 | `/stop` aborts a hung run | a long/hung run | send `/stop` | `Stopping current run.`; slot freed | P1 | ✅ |
| 5.5 | Straggler kill on shutdown | `GANTRY_IPC_SHUTDOWN_KILL=1` | shutdown with a live runner | straggler SIGKILLed after grace (log: `SIGKILLed straggler runner`) | P2 | ✅ (retained runner listed in `detachedRuns`, then `SIGKILLed straggler runner after shutdown grace (GANTRY_IPC_SHUTDOWN_KILL) {groupJid:wa:000005050,pid:92528}`) |
| 5.6 | Multi-instance lease (horizontal) | 2 cores on same DB | inbound for one convo | only the lease-owner processes (claim-first-wins); no double reply; reconciler recovers if owner dies | P2 | ✅ (mechanism: 19/19 unit pass — `claim-gate` (lease acquire/heartbeat/release), `reconciler` (**`does not enqueue when the ownership claim loses`** = no double-reply; `claims missed or expired work` = owner-death recovery), `stale-lease-terminal`; `conversation-owner-lease.postgres.integration.test.ts` in CI. Same DB-lease exclusivity class proven live in 8.6/7.4. Live 2-core run deferred — heavy setup) |

## 6. Overload / saturation

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 6.1 | Excess chats queue + drain | `total_workers:2` | send 6 distinct numbers fast | 2 run, 4 queued; all 6 eventually reply; no message lost | P0 | ✅ |
| 6.2 | Sustained overload | `total_workers:2` | send 10+ over time | queue absorbs; process count never exceeds ceiling; no crash | P1 | ✅ |
| 6.3 | Jobs vs chats isolation | `total_workers:2, max_job_runs:2` | run scheduled jobs + chats together | chats gated by total_workers, jobs by max_job_runs; neither starves the other | P1 | ✅ (unit+structural: separate `activeMessageCount`/`activeTaskCount` counters & gates; unit `runs tasks even when message pool is saturated` + `respects message concurrency limit`. Live job-trigger N/A — Boondi's agent scheduler is disallowed) |
| 6.4 | Retry backoff (no hot loop) | force a reply path to fail | send | exponential backoff (`Scheduling retry with backoff`), not a tight retry loop; gives up after max retries | P1 | ✅ (live: `retryCount:1 delayMs:5000`, retry fired exactly 5s after fail = no hot loop; give-up unit-tested `stops retrying after MAX_RETRIES and resets`) |

## 7. Background: digest + short-memory sweep (in-core)

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 7.1 | Idle sweep writes digest + memory | a finished convo | wait `conversation_idle_after_ms` (or `/digest-session`) | `agent_session_digests` row + `memory_items` rows; `Idle session memory extracted` | P0 | ✅ (`/digest-session` → "Digest processed. New digest: yes"; `agent_session_digests` row written and proven to drive cross-worker recall in 5.3. `memory_items` is content-dependent — 0 durable facts from this short intake) |
| 7.2 | Parallel lanes | `idle_sweep_concurrency:3`, ≥3 idle sessions | sweep | up to 3 extractions concurrent | P1 | ✅ (unit `idle-sweep-drain.test.ts`: `mapWithConcurrency runs at most limit tasks at once` 3/3) |
| 7.3 | Cursor-only-on-success + backoff | force one extraction to fail | sweep twice | failed session not advanced → retried; repeat-fail backs off | P1 | ✅ (unit: mcp-crm `watcher.test.ts` 16/16 — stop-at-gap, advance-cursor-per-success, soft-fail isolation, backs-off-repeatedly-failing, monotonic cursor; in-core `idle-sweep-cursor.integration.test.ts` exists (CI). Live: mcp-crm cycles advance per-success) |
| 7.4 | Single-flight lease | (2 cores) | sweep | only one runtime sweeps; no double extraction | P2 | ✅ (DB contention on `gantry:idle-session-sweep` lease: A=true,B=false-while-held,B=true-after; also observed the LIVE core holding it mid-sweep → A=false. `idle-session-sweep.ts:182` wraps the sweep in `tryAcquireRuntimeAdvisoryLease`) |
| 7.5 | Sweep ≠ customer slot | run a sweep + a live chat | concurrently | chat reply latency unaffected; sweep uses no GroupQueue message slot | P0 | ✅ (structural) |

## 8. Background: CRM extraction (mcp-crm)

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 8.1 | Watcher reads knobs from yaml | set `max_parallel_extractions/batch_size/db_pool_size` | restart mcp-crm | `digest_watcher_started {maxParallelExtractions,batchSize}` matches yaml | P0 | ✅ |
| 8.2 | Parallel distinct-customer extraction | `max_parallel_extractions:2`, ≥3 customers w/ digests | run a cycle | peak 2 concurrent extractions (not 1, not 3) | P0 | ✅ (unit) |
| 8.3 | Bookmark stop-at-gap | 2 digests for 1 convo, force older to parse-fail | run cycle | cursor NOT advanced past the fail; failed digest re-picked next cycle; later digest not skipped | P0 | ✅ (unit + DB) |
| 8.4 | Monotonic cursor | — | replay an older advance | cursor never moves backward | P1 | ✅ (live DB) |
| 8.5 | Per-conversation backoff | force repeated parse-fail | multiple cycles | failing convo skipped within its backoff window, retried after | P1 | ✅ (unit) |
| 8.6 | Single-flight advisory lease | (2 mcp-crm) | overlapping cycles | only one extracts (`pg_try_advisory_lock`); no double-write | P2 | ✅ (direct 2-conn contention on key `0x426f6e64`: A=true, B=false while held, B=true after release; `withDigestWatcherLease` wraps every cycle in this lock on a dedicated conn) |
| 8.7 | Pool-size deadlock guard | `db_pool_size < max_parallel_extractions+1` | restart mcp-crm | boot rejects with a clear error | P1 | ✅ (unit) |
| 8.8 | End-to-end CRM capture | a lead-shaped convo | `/digest-session` then watcher auto-extracts | `boondi_business_records` row (status ladder, band) | P1 | ✅ (000005037 → row: status=lead, band=P4, intent=corporate, occasion=Diwali, quantity=75, buyer_type=employee_gifting, score=43, summary populated. Auto-pipeline digest→watcher→extract→record) |
| 8.9 | CRM burst ≠ customer slot | trigger extraction + live chat | concurrently | chat unaffected (mcp-crm is a separate process) | P0 | ✅ (structural) |

## 9. Token isolation seam

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 9.1 | Unset → shared token (dev) | `.env GANTRY_BACKGROUND_ANTHROPIC_TOKEN` commented | restart mcp-crm | `background_token_source: gantry_credential_center` | P0 | ✅ |
| 9.2 | Set → background token wins | set the env var | restart mcp-crm | `background_token_source: GANTRY_BACKGROUND_ANTHROPIC_TOKEN` (revert after!) | P1 | ✅ |

## 10. Settings / config robustness

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 10.1 | Old knobs rejected | add `runtime.queue.max_message_runs` (or `warm_pool.size`/`max_bound_workers`) | restart core | boot rejects: "not supported" | P0 | ✅ (unit) |
| 10.2 | `warm_reserve > total` rejected | `warm_reserve_workers:5, total_workers:2` | restart core | boot rejects (carve-out invariant) | P0 | ✅ (unit) |
| 10.3 | New knobs round-trip | render → parse | — | values preserved; no old keys emitted | P1 | ✅ (unit) |
| 10.4 | Formatter can't break it | open/save settings.yaml in editor | format-on-save | `.prettierignore` keeps it untouched → core still parses | P0 | ✅ (fixed) |
| 10.5 | Live re-read on edit | edit a knob WITHOUT restart | send a msg | core re-parses on revision change (this is the path that broke on the bad YAML) | P1 | ✅ (observed) |

## 11. Cross-cutting / integration

| # | Scenario | Setup | Trigger | Expect | Pri | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 11.1 | Cold start → first reply | fresh boot | first webhook | guardrail → agent → Shopify lookup → reply | P0 | ✅ |
| 11.2 | Returning customer context | a customer with a CRM lead (e.g. 000005037) | send neutral follow-up | memory/CRM context used in reply | P1 | ✅ (neutral "help me finalise my order" → reply *"Picking up from where we left off — 75 boxes of Motichoor Ladoo for your office Diwali party"*; log `boondi_crm_prefetch_succeeded provider:returning-customer-crm found:true`) |
| 11.3 | Guardrail direct_response uses no worker | fresh number "hi" | send | canned greeting <1s, no `Starting agent run` | P1 | ✅ |
| 11.4 | Live chat + both background worlds at once | chat + idle sweep + CRM cycle | concurrently | chat unaffected; both background paths run; cursors correct | P1 | ✅ (foreground chat replied normally *while* in-core `/digest-session` sweep ran concurrently; CRM watcher polls continuously as a separate process — 8.8/8.9. Chat latency unaffected) |

---

## 12. Suggested order (highest value first)

1. **P0 worker model** (open): 1.2, 3.1, 3.2, 6.1 — confirm the two-knob model at a couple of values.
2. **P0 continuity & recovery** (open): 4.1, 5.2, 5.3 — the "worker dies / user returns" set you called out.
3. **P0 background end-to-end** (open): 7.1, 8.8 — digest+memory and CRM capture produce DB rows.
4. **P1 edges**: 2.3/2.4 (dial), 3.3 (TTL), 6.2/6.4 (overload/backoff), 7.3 (sweep failure), 5.4 (`/stop`).
5. **P2 multi-instance**: 5.6, 7.4, 8.6 — only if you run two cores / two mcp-crm.

Already proven during implementation (re-verify only if you want): 1.1, 1.5, 2.1, 2.2, 3.4, 4.2, 7.5, 8.1–8.5, 8.7, 8.9, 9.1, 9.2, 10.1–10.5, 11.1, 11.3.
</content>
