# Boondi Single-Chat Reply Latency — Measured Diagnosis & Fix Plan (2026-06-10)

Planning-only session. Scope: **latency of one isolated chat reply** (the 3-slot
concurrency limit is explicitly out of scope, though it intruded once — see
T6). Every number below is a fresh measurement from this session (14:33–14:52
UTC), produced per `docs/BOONDI-E2E-TESTING.md`: signed
webhooks from fake listed numbers, replies polled every 5 s, every conversation
verified in the admin panel. No fixes were implemented. The only repo edit was
two temporary measurement marks in `query-loop.ts`, reverted the same hour
(`git diff` clean); `~/gantry/.env` `LOG_LEVEL` was flipped to debug for the
session and restored.

This document does **not** rely on the pre-existing draft
`docs/BOONDI-LATENCY-PLAN.md`; overlaps and corrections are listed in §8.

---

## 1. What was measured

Instrumentation used (all pre-existing, plus config):

- Core flow log (`GANTRY_FLOW_LOG=1`) + `LOG_LEVEL=debug` so the runner's
  stderr (`[agent-runner] [msg #N]`, per-result `Usage […]` lines) lands
  timestamped in the core log → `/tmp/gantry-core-latency.log`.
- The env-gated runner boot probe (`GANTRY_TIMING_LOG=/tmp/agent-timing.jsonl`,
  marks `runner_loaded` / `before_sdk_query` / `first_sdk_message`), forwarded
  to children at `agent-spawn.ts:584`.
- The Claude-CLI session transcripts the runner already writes:
  `~/gantry/agents/boondi_support/.llm-runtime/claude/projects/-Users-caw-d-gantry-agents-boondi-support/*.jsonl`
  — per-API-call timestamps, tool calls, and exact token usage
  (`cache_read/creation_input_tokens`). This is the ground truth core's flow
  log cannot see (core only observes MCP proxy calls, so it misses ToolSearch
  / Skill rounds entirely).
- Two temporary `timingMark()` calls bracketing the post-result
  `readContextUsage()` (reverted after one run).

### Run table (send → outbound reply persisted, isolated runs)

| Run | Scenario (fresh number unless noted) | Total | Sonnet calls | Notes |
| --- | --- | --- | --- | --- |
| T1 | "hi" → guardrail canned greeting | **0.52 s** | 0 | non-LLM floor of the pipeline |
| T2 | "Do you do home delivery in Mumbai?" | **17.3 s** | 2 | Skill(boondi-kb) round + compose; cold |
| T3 | "Do you have kaju katli? What does it cost?" | **28.6 s** | 3 | 1 ToolSearch + search_products + compose; cold |
| T4 | warm follow-up on T3's live session | **10.0 s** | 2 | no ToolSearch, cache hits |
| T5 | "Check my last order?" | **44.3 s** | 5 | 2 ToolSearch + list+get + compose; cold |
| T6 | same as T5, fresh number | (60.9 s from spawn) | 5 | **queued 2 m 19 s behind 3 idle children first** — excluded from send→reply stats |
| T7 | no-keyword message (classifier path) | 42.1 s | — | **haiku classifier alone: 11.0 s** pre-agent |
| T8 | same as T5 (source-mode runner, instrumented) | **45.6 s** | 5 | tail attributed: `getContextUsage()` = 3.24 s |
| ref | operator's real turn, 12:04 UTC (fast window) | 27.1 s | 5 | same structure, rounds 2.3–4.8 s |

All eight test conversations are recorded both directions in the admin panel
(proof of record, §7).

### Anatomy of the headline case (T5, 44.3 s, cold order-status)

```
0.42 s   webhook → DB → message-loop pickup (≤500 ms poll)
0.15 s   guardrail (deterministic allow) + spawn prep
0.48 s   runner boot (dist) + Claude-CLI subprocess boot to init
8.2 s    round 1  ToolSearch "select:mcp_call_tool,mcp_list_tools" → "No matching deferred tools found"  [cR=0, cW=25,994]
9.0 s    round 2  ToolSearch "mcp call tool shopify" → finds mcp__gantry__mcp_call_tool
6.9 s    round 3  mcp_call_tool → list_orders_for_customer   (IPC leg 0.73 s + Shopify 0.91 s inside)
2.5 s    round 4  mcp_call_tool → get_order                  (IPC leg 0.56 s + Shopify 0.56 s inside)
11.0 s   round 5  final compose — 131 output tokens
2.35 s   post-result tail (getContextUsage) before core may send
0.1 s    leak-guard + persist + dry-run send
= 44.3 s
```

The same five-call structure with the same **failed `select:`** first round
appears in 12:04, T5, T6 and T8 (4/4 of order-status turns).

---

## 2. Root causes, ranked by measured contribution

### RC1 — Five sequential LLM rounds for the most common intent (≈55–75 % of the turn)

A cold order-status reply costs **5 sonnet rounds**; only 2 do useful work.

- **RC1a — ToolSearch discovery detour (2 rounds, 5.9–21 s).** All
  `mcp__gantry__*` tools (38 of them, incl. `mcp_call_tool`) are *deferred*:
  their schemas are not in context, so the model must call ToolSearch first.
  Worse, its prompt teaches the short names, so the first attempt
  (`select:mcp_call_tool,mcp_list_tools`) **deterministically fails** ("No
  matching deferred tools found" — registry wants `mcp__gantry__…`), forcing a
  second keyword search. Evidence: transcripts of 12:04 / T5 / T6 / T8, all
  identical. T3 (product search) needed one ToolSearch round; T2 (policy)
  spent its round on Skill(boondi-kb) instead — every cold turn pays at least
  one discovery/skill round.
- **RC1b — list→get two-step on order intent (1 round + 1 MCP trip, 3–15 s).**
  `list_orders_for_customer` returns no line items, so the model must call
  `get_order` to answer "what did I order" (rounds 3+4 above).
- **RC1c — final compose is consistently the slowest round (4.8–13 s for
  90–200 output tokens, ~19–26 tok/s effective incl. TTFT).** Long formatted
  WhatsApp replies multiply the per-token price of RC2.

### RC2 — API round-time degradation: the account is throttled (multiplier 2–4×)

Identical payloads, wildly different speeds: the 12:04 window ran rounds at
2.3–3.6 s; by 14:34–14:51 the *same* requests (byte-similar cW values) took
8–15.6 s. The SDK's `rate_limit_event` at every session start, captured once
with payload logging:

```json
{"status":"allowed_warning","rateLimitType":"five_hour","utilization":0.91,
 "surpassedThreshold":0.9,"resetsAt":1781108400}
```

**The shared Claude-subscription OAuth credential was at 91 % of its 5-hour
window** (chat turns + guardrail haiku + memory extractor + CRM extractor all
spend from it; a cold turn writes ~26–30 K cache tokens, ≈ $0.11–0.16). The
20→50 s spread of the complaint maps to this pressure: same pipeline, fast
window = 27.1 s, throttled window = 44–61 s. At 100 % it becomes hard stalls.

### RC3 — ~26 K-token prompt prefix, re-ingested on every new conversation (2–6 s + cost)

First call of every session: `cache_read=0`, `cache_creation=25,980–25,994` —
measured on T2/T3/T5/T6/T8, **including T8 started within 5 minutes of T6's
identical-shape write** → cross-session prompt-cache reuse is zero. The
creation sizes differ by ±14 tokens tracking the first user message
(name/phone/timestamp), consistent with a single cache segment that ends after
message[0] — a per-session-unique suffix busting the whole prefix. (Exact
breakpoint layout needs one request-capture run to confirm; see F5.)

What the ~26 K prefix is (measured chars; token shares estimated):

| Component | Size | Share |
| --- | --- | --- |
| Boondi append: SOUL.md 23,849 c + CLAUDE.md 23,897 c + MCP-services block (flow-logged total 54,360 chars) | ≈ 13.5–14 K tok | **> 50 %** |
| claude_code preset system prompt + schemas of the 11 *loaded* native tools (Read/Glob/Grep/Bash/Edit/Write/LS/MultiEdit/Agent/ToolSearch/Skill) | ≈ 11–12 K tok | ~45 % |
| msg[0]: memory block (652 c) + context/messages wrapper (201 c) + skill listing (551 c, **includes gantry-admin**) + deferred-tools lists | ≈ 0.7–0.8 K tok | ~3 % |

A WhatsApp sweets-shop bot carries a full coding-agent system prompt and
coding-tool schemas on every call; 38 admin/scheduler MCP tools are deferred
(saving prefix, but causing RC1a).

### RC4 — Post-result tail: `getContextUsage()` blocks the reply (2.2–4.1 s, every turn)

The reply text is fully streamed and final, then `query-loop.ts` awaits
`readContextUsage(sdkQuery)` **before** writing the result envelope core sends
from. Timed exactly with the temporary marks: `result_received` →
`before_context_usage` +5 ms → `after_context_usage` **+3.24 s** → reply
persisted +10 ms (T8). Observed as a 2.2–4.1 s gap on every run (T2 4.1 s,
T3 2.2 s, T4 2.4 s, T5 2.35 s, T6 3.4 s). Its output (`contextUsage`) feeds
only the model-status store / session-command formatting — diagnostics, not
the reply. On a warm turn this tail is ~24 % of total latency.

### RC5 — Guardrail classifier path (1–11 s, ~minority of messages)

Deterministic decisions cost 15–25 ms (T1/T2/T3/T5). When no regex matches,
the haiku classifier decides: **11.0 s measured at 91 % utilization** (T7) —
historically 1–3 s at low pressure. Same RC2 multiplier, pre-agent.

### RC6 — Fixed plumbing (≈1–2 s total; acquitted as a major cause)

Measured: webhook→pickup ≤ 0.5 s (500 ms message-loop poll), spawn prep
0.12–0.15 s, dist runner boot 0.13 s, CLI subprocess boot to init 0.34–0.98 s,
SDK→core IPC leg per MCP call 0.2–1.0 s, Shopify server time 0.5–2.3 s/call,
send+persist ≈ 0.1 s. The non-LLM floor end-to-end is **0.52 s** (T1).

### Acquitted with evidence

- **Background CRM/memory extraction and dreaming do not block the reply
  path.** Memory extraction fired at 14:40:06 / 14:46:11 / 14:47:33 — all
  ≥5 min *after* the respective session's last turn (idle sweep), and CRM
  digest cycles ran 14:42:32 / 14:46:32 / 14:50:32 on its 240 s timer, between
  turns. One memory extraction overlapped T6's loop without blocking it
  structurally. **Caveat → RC2:** each is an LLM call on the *same throttled
  account*. Dreaming is cron `0 1 * * *` (not in window).
- **Shopify MCP server**: 0.5–2.3 s per call — real but small vs. the rounds
  around it.
- **Outbound delivery**: flow:outbound→persisted < 0.1 s under dry-run.

---

## 3. Fix plan, ranked by payoff-to-effort

### Quick wins (config/prompt/one-liners — do these first)

> **Status legend (annotated 2026-06-11):** ✅ DONE · ⏸ DEFERRED · 🔒 CLOSED/DROPPED · 🔵 HELD for operator. See `BOONDI-LATENCY-P1-RESULTS-2026-06-11.md` and the "Before / After results (2026-06-11)" section at the foot of this file for measured outcomes.

| # | Status | Fix | Expected saving | Effort / risk |
| --- | --- | --- | --- | --- |
| **F1** | ✅ DONE (P1) | **Kill the ToolSearch detour.** Right shape: shrink the gantry MCP surface for the sales persona to the few tools Boondi uses (`mcp_call_tool`, `mcp_list_tools`, memory tools…) via the existing `selectedGantryMcpToolNames`/settings plumbing so the schemas load upfront instead of deferring (≈ +2.4 K prefix tokens — the cW=2,363 observed when ToolSearch loaded them — net win vs. 2 rounds). 30-min stopgap: change `agents/boondi_support/CLAUDE.md` to name the exact full tool ids (`select:mcp__gantry__mcp_call_tool,mcp__gantry__mcp_list_tools`) so the first search succeeds. | **5–20 s on every cold tool turn** (removes 1–2 rounds) | Low. Verify the deferral threshold with one run; agent-agnostic (config + Boondi-owned prompt) |
| **F2** | ✅ DONE (P1) | **Unblock the reply from `getContextUsage()`** — write the result envelope first, attach `contextUsage` to the post-close envelope (or fetch it async). Consumers are status/diagnostics only (`model-status-store`, session-command format). | **2.2–4.1 s on every turn**, warm included | Low (runner-only ordering change) |
| **F3** | ⏸ DEFERRED (pre-launch gate) | **Fix the account pressure.** Move Boondi prod traffic to a dedicated, properly-tiered API key (the raw-API 429 note in repo memory applies to the OAuth token, not an `sk-ant-api03` key); at minimum stop the background extractors and dev testing from sharing the live agent's credential. | Restores rounds from 8–15 s to 2.3–3.6 s ⇒ **cold turn ~44 s → ~25 s at peak**; removes the 20→50 s variance band | Operational; changes billing model. Without this, every other fix is partially masked at peak |
| **F4** | ✅ DONE (P1) | **Collapse list→get**: add `get_recent_orders_with_details` (or enrich `list_orders_for_customer` with line items for the latest N) in `packages/mcp-shopify` + a CLAUDE.md hint to prefer it for order-status. | **3–15 s on the most common intent** (one round + one MCP trip) | Low-medium; watch result-payload size (tool results are triple-JSON-encoded — trim while there) |

Combined expectation (F1+F2+F4, fast-window rounds): cold order turn
≈ 0.5 pre + 1.0 boot + 2 useful rounds (~3 + 5 s) + 1 MCP (~1 s) + compose ≈
**10–14 s**; warm turns ≈ **4–6 s**. With F3 these numbers hold at peak.

### Deeper / structural (after the quick wins)

| # | Status | Fix | Expected saving | Effort / risk |
| --- | --- | --- | --- | --- |
| **F5** | (a) 🔒 CLOSED · (b) 🔵 HELD · (c) ✅ DONE (P2) | **Prefix diet + cache layout.** (a) [🔒 CLOSED — SDK owns the breakpoint, not Gantry-fixable] One request-capture run (e.g. `ANTHROPIC_LOG=debug` or local proxy in the runner env) to confirm cache-segment layout; add a stable breakpoint after system+tools so new sessions hit the cached prefix (kills the 26 K re-ingest, ~2–6 s cold). (b) [🔵 HELD for operator — eval-gated] Trim the 54 KB append (SOUL+CLAUDE) — target ≤ half; A/B against the lead-capture eval set, never eyeball. (c) [✅ DONE (P2) — cold prefix 28.9K→20.8K cache-creation tokens] Drop coding tools (Bash/Edit/Write/MultiEdit/Agent/NotebookEdit…) and the `gantry-admin` skill from the sales persona via config — fewer schemas, smaller prefix, less attack surface. | 2–6 s cold + ~40 % cost cut + faster every round | Medium; accuracy risk gated by eval set. Keep core agent-agnostic (settings-driven tool selection) |
| **F6** | ✅ DONE (P2) | **Compose discipline**: cap reply length/formatting for WhatsApp in CLAUDE.md (most replies need ≤ 60 tokens, measured replies were 90–200). | 2–6 s on compose round | Trivial change, UX trade-off |
| **F7** | 🔒 DROPPED by operator (plumbing exists) | **Perceived latency**: implement the existing `ProgressSink`/typing plumbing for the Interakt channel (instant "checking that for you…" ack ≤ 2.5 s). Doesn't cut real latency — do it because even 10–14 s feels long on WhatsApp. | perceived 44 s → ~2.5 s | Medium; channel-layer only |
| **F8** | 🔒 DEPRIORITIZED by the data | **Process/runtime structure** (warm runner pool, in-process SDK instead of CLI subprocess): boot to first API call measured only 0.6–1.5 s — **not** the bottleneck today. Revisit only if sub-5 s cold turns become the goal after F1–F6. | ~1 s | High effort — explicitly deprioritized by the data |

Also reproduced, out of scope but urgent elsewhere: **slot starvation** — T6
queued 2 m 19 s behind three *idle* children (each lingers `IDLE_TIMEOUT` =
30 min holding a slot at `maxMessageRuns` = 3). Track as its own
availability fix.

---

## 3a. Operator review (2026-06-10) — decisions, constraints, verification

Reviewed with the operator; these decisions reshape §3 priorities.

### Decisions per root cause

- **RC1a (38-tool surface):** approved, stronger form — *keep only the tools
  Boondi actually needs* (≈2–4: `mcp_call_tool`, `mcp_list_tools`, possibly
  the memory pair). Verified caveat: the selection is **add-only today**
  (`selectedGantryMcpToolNames` seeds the full default set,
  `apps/core/src/runner/gantry-mcp-tool-surface.ts:101`; native coding tools
  hardcoded in `native-sdk-tools.ts`), so this needs a small **generic** core
  change: a settings-driven per-agent tool-surface restriction honored by
  `composeAgentCapabilities`. Boondi's keep-list lives in its
  `agents.boondi_support` settings block. Stopgap meanwhile: exact full tool
  ids in `agents/boondi_support/CLAUDE.md` so the first ToolSearch `select:`
  succeeds.
- **RC2 + RC5 (account throttling, classifier latency): deferred by
  decision** — no credential change now; a fresh 5-hour window resets the
  symptom. Mitigation now: **continuous measurement** (persist per-turn model
  usage + log the `rate_limit_event` utilization per session so every latency
  number carries its account-pressure context). On record: production traffic
  and the background extractors spend from the same window, and the planned
  concurrency fix multiplies the drain (3 concurrent users ≈ 3× faster) — a
  dedicated, properly-tiered API key is a **pre-launch gate**, re-decide
  before real customers/concurrency.
- **RC3 (26 K prefix): approved, two tracks.** (a) Machinery diet via the
  same generic tool-surface mechanism (drop Bash/Edit/Write/Agent/etc. and the
  `gantry-admin` skill from Boondi runs). (b) Editorial diet of SOUL.md +
  CLAUDE.md (48 KB → target ≈ 50 %) preserving behavior — quality judged by
  re-running the regression + lead-capture scenarios before/after, never by
  eyeballing; adopt only if quality holds. The `claude_code` preset baseline
  is SDK-imposed; making it optional is a follow-up investigation. Cross-
  session cache repair stays gated on one request-capture run.
- **RC1b (list→get two-step): combined order tool confirmed by the
  operator** — proceed with F4 (`packages/mcp-shopify` + CLAUDE.md guidance;
  Boondi-layer only).
- **RC4 (getContextUsage tail): approved as async** — write the reply
  envelope first; fetch context usage afterwards and attach it to a later
  envelope (consumers are status/diagnostics only).
- **RC6 (fixed plumbing): no action.** It is the mechanical floor (polls,
  process boot, IPC hops, Shopify HTTP, persist) — measured ≈1–2 s total,
  non-LLM floor 0.52 s. Listed to prove it is *not* the problem. Optional P3
  polish someday: shorten the 500 ms message poll + IPC poll intervals
  (~0.3–0.7 s).

### Cross-cutting constraints (apply to every fix)

1. **Concurrency-forward:** a proper concurrency fix (slots/queue — T6
   reproduced idle-children starvation) is coming separately. Nothing here may
   fight it: tool-surface restriction is per-agent config (multi-agent safe);
   F2's envelope reordering is per-run; warm-pool ideas (F8) stay parked until
   the slot model is fixed; and note the shared-credential pressure (RC2)
   scales with concurrency — see the pre-launch gate above.
2. **Gantry/Boondi boundary:** core changes must be agent-agnostic and
   settings-driven (tool-surface restriction, envelope ordering — sensible for
   ANY agent). Boondi-owned changes stay in `agents/boondi_support/*`
   (SOUL/CLAUDE diet, CLAUDE.md tool ids) and `packages/mcp-shopify`
   (combined order tool). No Boondi names/logic in core.

### Verification protocol — the latency suite

Per-change verification uses exactly the `docs/BOONDI-E2E-TESTING.md` method
(signed webhooks, 5 s polling, admin-panel proof), plus four disciplines this
investigation showed are mandatory for before/after comparisons:

1. **Control for account pressure (RC2 confound):** record the
   `rate_limit_event` utilization with every run; compare only like-for-like
   windows (or run suites in a fresh 5-hour window). Without this, a fix can
   appear 2–4× better or worse than it is.
2. **Timestamps from the flow log / DB rows**, never poll-arrival times (5 s
   poll granularity would swamp the effect).
3. **Cold and warm measured separately** — cold = fresh fake number (or
   `/new`); warm = follow-up into the live session. ≥3 samples per scenario,
   compare medians (round-time variance is large).
4. **Slot isolation before every send** — no queued or idle-child-held slots
   (T6's 2 m 19 s queue wait must never contaminate a sample); use a short
   `IDLE_TIMEOUT` for suite runs per runbook §3.

Fixed scenario set (mirrors this report): T1 greeting (guardrail floor),
T2 policy question, T3 product lookup, T4 warm follow-up, T5 order-status.
First implementation task: extend `scripts/measure-latency.mjs` into this
suite — per-stage table from the flow log **plus per-round times and
cache_read/creation from the session transcripts**, utilization stamped per
run.

### Revised priorities

> **Completion status annotated 2026-06-11** — markers below reflect committed
> work; see `BOONDI-LATENCY-P1-RESULTS-2026-06-11.md` and the "Before / After
> results (2026-06-11)" section at the foot of this file.

- **P1 (now):** ✅ DONE — F1 tool-surface restriction (+ CLAUDE.md stopgap) · F2 async
  contextUsage · F4 combined order tool *(operator-confirmed 2026-06-10)* ·
  the latency-suite harness + continuous usage/utilization logging
  (`scripts/measure-latency.mjs` + per-turn `model.usage` / `model.rate_limit`).
- **P2 (next, eval-gated):** F5c machinery diet ✅ DONE (cold prefix 28.9K→20.8K) ·
  F6 compose discipline ✅ DONE · F5b editorial SOUL/CLAUDE diet 🔵 HELD for
  operator (eval-gated) · F5a request-capture run → cache-breakpoint fix
  🔒 CLOSED (Claude Agent SDK owns the breakpoint; not Gantry-fixable).
- **Deferred by decision:** ⏸ DEFERRED — F3 dedicated API key (pre-launch gate) ·
  classifier latency (rides on F3). **Note (2026-06-11):** the guardrail was
  subsequently made **classifier-only** (commit `fc6d8e07`; deterministic
  fast-path removed) by operator decision, so the 0-LLM deterministic stage no
  longer covers the majority — every turn now pays a flat ~4.5–5.5 s haiku
  classifier. This sharpens the case for F3.
- **Parked:** 🔒 DROPPED — F7 typing/progress sink (UX decision; plumbing
  exists, `sendProgressUpdate`) · 🔒 DEPRIORITIZED — F8 process/runtime
  restructuring (data says ~1 s).

## 4. Where the 20–50 s actually goes (cold tool turn)

| Stage | Fast window (12:04) | Throttled window (T5/T8) | Fix |
| --- | --- | --- | --- |
| Webhook→pickup→guardrail→spawn→CLI init | ~2.3 s | ~1.1–2.0 s | — (floor) |
| ToolSearch detour (2 rounds) | 5.9 s | 17.2 s / 11.5 s | F1 |
| Useful tool rounds (2) + MCP trips | 8.1 s | 9.4 s / 15.9 s | F4 (halves it) |
| Final compose | 4.8 s | 11.0 s / 13.0 s | F6, F3 |
| Post-result tail (getContextUsage) | ~6.0 s* | 2.35 s / 3.24 s | F2 |
| Send+persist | 0.1 s | 0.1 s | — |
| **Total** | **27.1 s** | **44.3 s / 45.6 s** | |

\* the 12:04 tail also contained SDK end-of-turn work; instrumented value is
2.2–4.1 s.

Fixed overhead per reply ≈ 2 s (pipeline) + 2–4 s (tail, F2). Per-LLM-round
cost ≈ 2.3–3.6 s healthy, 8–15.6 s throttled (F3). Round count is the lever
with the biggest structural payoff (F1/F4). Per-MCP-call cost ≈ 0.7–3.3 s
(server + IPC legs) — fine at 1–2 calls.

## 5. Background jobs verdict (explicitly tested, not assumed)

Timer-driven and post-idle only; timestamps in §2-acquitted. They cost account
budget (RC2), not wall-clock on the reply path.

## 6. Measurement integrity

- Every turn ran with zero other active runs (checked process table + log)
  except T6, whose queue wait is excluded and reported separately.
- Reply timestamps are DB/flow-log times, not poll-arrival times.
- Dry-run + fake listed numbers throughout; flags verified on the live
  process (`Outbound dry-run: sent to listed test number` in-log).
- Runner shape: T2–T7 ran the production dist runner; T8 ran source-mode
  (boot 0.13 s → 0.6 s; noted inline).

## 7. Proof of record (admin panel)

All test conversations visible both directions at
`http://localhost:3000/?c=conversation:wa:<phone>` for phones
`000000031…037` (T1–T8) plus `919654405340` (12:04 reference). API check used:
`/api/conversations` — every test row shows `in:1 out:1` (T3/T4 share
`000000033`: `in:2 out:2`).

## 8. Relation to the earlier draft (`docs/BOONDI-LATENCY-PLAN.md`)

Independently confirmed: slot starvation (reproduced live), Interakt has no
progress/typing sink, 54,360-char system prompt, MCP server itself is fast,
background extraction off the hot path, webhook ACK immediate.

Corrected / new with transcript-level evidence:

- The draft's "10.65 s spawn→first tool" conflated **two ToolSearch inference
  rounds (invisible to the flow log) plus boot**; actual boot+init is
  0.6–1.5 s. Its Phase-2/3 emphasis on process boot (warm pools, dropping the
  CLI) targets ~1 s, not 5–8 s — deprioritized here (F8).
- The "anomalous 10.8 s compose" decomposes into a slow-but-normal compose
  round (RC1c/RC2) **plus** the previously invisible 2.2–4.1 s
  `getContextUsage()` tail (RC4) — now measured exactly.
- Cache behaviour is now measured (draft listed it unknown): within-session
  hits work; cross-session reuse is zero even inside the TTL (RC3).
- New, decisive: the failed `select:` ToolSearch pattern (RC1a) and the
  account-level `five_hour` utilization 0.91 throttle (RC2) — neither appears
  in the draft.

## 9. Evidence artifacts

- Instrumented core log: `/tmp/gantry-core-latency.log` (14:30–14:52 UTC)
- Boot/tail probe: `/tmp/agent-timing.jsonl` (T8 marks incl.
  `before/after_context_usage`)
- SDK transcripts (per-call usage):
  `~/gantry/agents/boondi_support/.llm-runtime/claude/projects/-Users-caw-d-gantry-agents-boondi-support/`
- Pre-session reference turn: quoted 12:04 UTC lines (original
  `/tmp/gantry-core-dev.log` was recycled on restart; the turn's transcript
  JSONL `53f48237…jsonl` remains)
- CRM watcher log: `/tmp/mcp-crm-dev.log`
- Rate-limit payload, failed-ToolSearch tool results, per-call token tables:
  quoted verbatim in §1–2 from the artifacts above.

---

## Before / After results (2026-06-11)

Outcome of the implemented fixes, measured per the §3a verification protocol.
All numbers are **medians**, all captured in healthy `allowed` 5-hour
rate-limit windows (the RC2 confound is controlled — like-for-like windows on
every side). Sources: pre-fix and After-P1 medians from
`BOONDI-LATENCY-P1-RESULTS-2026-06-11.md` §2; "Now" medians from a
post-runtime-reset run of `scripts/measure-latency.mjs` (3 samples/scenario,
detail in `/tmp/latency-now.json`).

### The confound you must read before the table

The **After-P1** numbers were measured while the guardrail still ran its
**deterministic + classifier** form: BSS keywords and greetings hit a **0-LLM
fast-path** (15–25 ms), so "hi" cost ~276 ms and keyword turns paid no
classifier tax. After P1, the guardrail was switched to **classifier-only**
(operator decision, commit `fc6d8e07`; the deterministic layer was removed from
`agents/boondi_support/guardrails/guardrail.ts`). That adds a flat
**~4.5–5.5 s haiku-classifier call to *every* turn** — which is why a bare "hi"
is now ~4.5 s instead of 276 ms. This is a guardrail-mode change, **not** an
agent-path regression.

Consequences for reading the data honestly:

- The **structural agent-path fixes (F1 / F2 / F4 / F5c) are durable and hold.**
  They live below the guardrail and are guardrail-independent: round count, MCP
  trips, and the post-result tail all improved and stayed improved. T5 is now
  **2 rounds** (was 5) with **one** MCP trip (`get_recent_orders_with_details`,
  ~475–1007 ms) — F1+F4 hold. The post-result tail is **63–95 ms** every
  turn — F2 holds (was 2.2–4.1 s).
- **End-to-end wall-clock is partially masked by the classifier-only guardrail
  tax.** To see the agent path, subtract the measured per-turn guardrail cost:
  **agent-path ≈ total − guard**. Example: T5 ≈ 13 892 − 5 243 ≈ **8.6 s agent
  path**, versus the ~21 s (mostly-agent) before. The structural win is real;
  the guardrail decision is a separate, deliberate latency trade.

### Before / after table

| Scenario | Before (pre-fix) | After-P1 | Now (classifier-only) | Now agent-path (total − guard) | Rounds now | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| T1 greeting (guardrail floor) | 325 ms | 276 ms | 4 496 ms | ≈ 0 ms (floor) | 0 | "Now" is ~all guardrail (4 512 ms haiku classifier); the 276 ms After-P1 was the 0-LLM deterministic fast-path that classifier-only removed |
| T2 policy question | 11 738 ms | 4 844 ms (−59 %) | 10 039 ms | ≈ 5 467 ms | 1 | guard 4 572 ms is the bulk of the delta vs After-P1; agent path is 1 round, tail 73 ms |
| T3 product lookup | 16 998 ms | 15 681 ms | 15 075 ms | ≈ 9 414 ms | 2 | guard 5 661 ms; agent path = `mcp_call_tool(search_products)` (~539 ms MCP) + compose, tail 88 ms; no ToolSearch detour (F1) |
| T4 warm follow-up (resume) | 11 408 ms | 14 837 ms | — (not re-measured) | — | — | classifier-bound (RC5), not an agent-path signal; not re-run this window |
| T5 order status | 21 248 ms | 10 407 ms (−51 %) | 13 892 ms | ≈ 8 649 ms | 2 | guard 5 243 ms; agent path = `get_recent_orders_with_details` once (~475–1007 ms) + compose, tail 63–95 ms (F1+F4+F2 all hold) |

Per-turn guardrail (haiku classifier) cost measured "Now": T1 4 512 ms,
T2 4 572 ms, T3 5 661 ms, T5 5 243 ms. Post-result tail 63–95 ms (F2 holds
everywhere).

### Bottom line

- **Agent-path latency dropped substantially and durably** — the round count,
  MCP-trip, and post-result-tail wins (F1/F4/F2) are real and guardrail-
  independent; F5c shrank the cold prefix 28.9K→20.8K cache-creation tokens.
- **Wall-clock for short/keyword turns rose** purely because the guardrail is
  now classifier-only (a deliberate operator decision), adding a flat
  ~4.5–5.5 s per turn. This is the single biggest remaining lever and is
  **not** an agent-path problem; it strengthens the case for F3 (dedicated key,
  which cuts the classifier's own round time) and re-opens F7 (perceived-latency
  ack) if the operator wants it.
