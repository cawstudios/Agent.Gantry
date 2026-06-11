# Boondi Latency P1 — Implementation Results (2026-06-11)

Implements the **P1 (now)** scope of
[`BOONDI-LATENCY-DIAGNOSIS-2026-06-10.md`](BOONDI-LATENCY-DIAGNOSIS-2026-06-10.md)
§3a: F1 tool-surface restriction (+ CLAUDE.md stopgap), F2 async
`contextUsage`, F4 combined order tool, and the latency-suite harness with
continuous usage/utilization logging. P2 / deferred / parked items were left
out of scope per the plan's own priorities.

Verification followed `docs/BOONDI-E2E-TESTING.md` exactly (signed webhooks
from fake listed numbers, flow-log/DB timestamps, admin-panel proof) plus the
four §3a disciplines: utilization stamped per sample, flow-log timestamps,
cold/warm measured separately, slot isolation before every send.

---

## 1. What shipped

| #           | Fix                                                                                                                                 | Change (Gantry/Boondi boundary respected)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**      | Settings-driven per-agent gantry MCP tool-surface restriction; schemas load upfront (`alwaysLoad`) so there is no ToolSearch detour | **Core (generic):** `agents.<folder>.tool_surface.gantry_mcp` keep-list parsed → threaded through `AgentInput`/`AgentRunnerInput` → `composeAgentCapabilities` (allow-list narrowed + `alwaysLoad` on the gantry MCP server) → runner `gantry-mcp-tool-surface`/`mcp/server` filter the registered schema set. **Boondi:** keep-list in `~/gantry/settings.yaml` (`mcp_call_tool`, `mcp_list_tools`, `memory_search`, `memory_save`); `agents/boondi_support/CLAUDE.md` stopgap names full tool ids. |
| **F2**      | Reply envelope no longer waits on `getContextUsage()`                                                                               | **Core (runner-only):** new `context-usage-emitter.ts` writes the result envelope immediately, fetches context usage on a serialized background chain, and emits it as a follow-up `result:null` envelope; bounded `flush()` at query end. Consumers (model-status store / session-command display) unchanged.                                                                                                                                                                                       |
| **F4**      | Combined order tool collapses `list→get` into one call                                                                              | **Boondi layer:** `packages/mcp-shopify` `get_recent_orders_with_details` returns latest N orders **with** line items + fulfillments (lean payload: no customer block / GID / SKU); CLAUDE.md routes order-status to it.                                                                                                                                                                                                                                                                             |
| **Harness** | Latency suite + continuous measurement                                                                                              | **Tooling:** `scripts/measure-latency.mjs` rewritten into the T1–T5 suite (≥3 samples, medians, cold/warm split, slot isolation, per-stage table from the flow log + per-round times/cache tokens from session transcripts, utilization stamped). **Core (generic):** runner emits SDK `rate_limit_event` → `model.rate_limit` runtime event + flow log; per-turn `model.usage` runtime event + flow log.                                                                                            |

---

## 2. Before / after (latency suite, healthy `allowed` window both sides)

Medians of 3 samples per scenario. Both runs were captured in a fresh 5-hour
window (`rate_limit` status `allowed`), so they are like-for-like per §3a
discipline 1 — the confound the diagnosis warns about is controlled.

Medians from `/tmp/latency-baseline.json` (before) and
`/tmp/latency-after-clean.json` (after).

| Scenario                      | Before median | After median          | Before rounds | After rounds | Notes                                                                                                                       |
| ----------------------------- | ------------- | --------------------- | ------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| T1 greeting (guardrail floor) | 325 ms        | **276 ms**            | 0             | 0            | non-LLM floor; unchanged by design                                                                                          |
| T2 policy question            | 11 738 ms     | **4 844 ms** (−59 %)  | 2             | 1            | F2 tail 674→104 ms; model also answered without the KB round this window                                                    |
| T3 product lookup             | 16 998 ms     | **15 681 ms**         | 4             | 4            | ToolSearch detour gone in all samples (F1); residual rounds = optional `boondi-kb` Skill consult, not discovery — see below |
| T4 warm follow-up (resume)    | 11 408 ms     | **14 837 ms**         | 1             | 1            | classifier-dominated (RC5), not an agent-path signal — see below                                                            |
| T5 order status               | 21 248 ms     | **10 407 ms** (−51 %) | 5             | 2            | headline: F1 + F4 + F2                                                                                                      |

### Structural changes observed (the durable, window-independent wins)

- **F1 — ToolSearch detour eliminated, confirmed per-round.** No after-sample of
  any cold tool turn contains a ToolSearch round (the baseline failed
  `select:` + keyword-search pair is gone). T5's per-round trace is now exactly
  `mcp_call_tool(get_recent_orders_with_details)` → compose in **all 3
  samples** (5 rounds → 2). The cold prefix loads the 4-tool gantry surface
  upfront (`cache_creation` ~28 K) instead of deferring + paying discovery.
- **F4 — order status is one MCP trip.** Every T5 sample calls
  `get_recent_orders_with_details` once (items + tracking inline); the
  `list_orders_for_customer` → `get_order` two-step is gone.
- **F2 — post-result tail collapsed** from 0.65–0.7 s to **0.08–0.16 s on every
  turn**, warm included (measured: T2 674→104 ms, T3 674→89 ms, T5 660→117 ms).

### Two honest caveats (not regressions)

- **T3's residual 4 rounds are model choice, not the F1 detour.** Per-round
  traces show 2 of 3 samples run `Skill(boondi-kb)` → `search_products` →
  compose (the 3rd skips the Skill and runs in 2 rounds, 10.9 s). The Skill
  consult is a Boondi prompt-design decision (P2 editorial-diet territory),
  not the ToolSearch discovery F1 removed — which is gone in every sample.
- **T4's higher median is the haiku classifier (RC5), not the agent path.** The
  warm follow-up "and how much would half a kilo cost?" hits no BSS keyword, so
  the guardrail classifier stage runs an LLM call — measured 7.3–10.6 s after
  vs 6.0–11.2 s before (comparable noise both runs). The agent path itself is
  one clean round with an 85–93 ms tail. RC5 is deferred by decision and rides
  on F3; this scenario is classifier-bound, not a fair agent-path comparison.

---

## 3. Surface Impact Matrix (per AGENTS.md)

| Surface                        | Status                  | Notes                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior               | **Changed**             | Reply envelope written before context-usage fetch (F2); gantry MCP schema set narrowed per agent (F1); order intent resolves in one MCP call (F4).                                                                           |
| `settings.yaml`                | **Changed**             | New optional `agents.<folder>.tool_surface.gantry_mcp` keep-list; parsed, validated, rendered back, exported in desired-state. Boondi block populated in `~/gantry/settings.yaml`; documented in `settings.example.yaml`.    |
| Postgres / runtime projection  | **Changed**             | New `runtime_events` rows: `model.usage` (per turn), `model.rate_limit` (per session). No schema/migration change — uses existing `runtime_events` table + event-type enum addition.                                         |
| Control API                    | **Unchanged by design** | Tool-surface is desired-state config read at boot; no new API endpoint. Existing desired-state export/import round-trips the field.                                                                                          |
| SDK / contracts                | **Changed**             | `McpServerConfig.alwaysLoad` plumbed to the SDK `mcpServers` projection (F1). No public contract package change.                                                                                                             |
| CLI                            | **Unchanged by design** | No new CLI verb; `tool_surface` is settings-owned and boot-parsed like `plugins`/`memory`.                                                                                                                                   |
| Gantry MCP tools / admin skill | **Changed**             | Per-run registered gantry MCP schema set is filtered to the keep-list; admin tools stay visible only when unrestricted or capability-selected (verified by unit test). No tool added/removed from the catalog.               |
| Channel / provider adapters    | **Unchanged by design** | No channel-layer change (F7 typing/progress sink remains parked per plan).                                                                                                                                                   |
| Docs / prompts                 | **Changed**             | `agents/boondi_support/CLAUDE.md` (tool ids + order-tool routing); `settings.example.yaml` (`tool_surface` block); this results doc. SOUL.md untouched (editorial diet is P2).                                               |
| Audit / events                 | **Changed**             | Two new runtime event types (`model.usage`, `model.rate_limit`); both flow through the existing `RuntimeEventExchange` audit path.                                                                                           |
| Tests / verification           | **Changed**             | New unit suites: `model-telemetry`, `context-usage-emitter`, `gantry-mcp-tool-surface`, `get-recent-orders-with-details`; extended `agent-capabilities` + `runtime-settings`. Latency suite is the e2e verification harness. |

### Cross-cutting constraints honored

- **Concurrency-forward:** tool-surface is per-agent config (multi-agent safe);
  F2's envelope reordering is per-run; no warm-pool/slot assumptions added.
- **Gantry/Boondi boundary:** every core change is agent-agnostic and
  settings-driven; no Boondi names/logic in core. Boondi-specific changes live
  in `agents/boondi_support/*`, `packages/mcp-shopify`, and the
  `agents.boondi_support` settings block.

---

## 3b. P2 progress (2026-06-11)

Worked the remaining plan items after P1. Status:

| Item | Status | Notes |
| --- | --- | --- |
| **F5c — machinery diet** (drop native coding tools) | **Done** | Generic per-agent `tool_surface.native` keep-list; Boondi keeps only `Skill`+`ToolSearch`. Verified live: cold prefix **28.9K → 20.8K** cache-creation tokens (~8K / ~28% smaller). The `gantry-admin` skill-listing drop deferred (minor ~100-200 tok). |
| **F6 — compose discipline** | **Done** | CLAUDE.md cap; verified replies stay tight (policy answer now a 2-liner). |
| **F5a — cross-session cache breakpoint** | **Blocked (not Gantry-fixable)** | Investigated: the Claude Agent SDK exposes no `cache_control`/breakpoint API, and the per-session cache-buster is the customer identity + memory in msg[0] (inherent). Relocating the breakpoint to after system+tools is SDK-internal. Requires an SDK change. |
| **F5b — editorial SOUL/CLAUDE diet** | **Held for operator** | Eval-gated by design ("never eyeball"). The machinery half of RC3 is captured by F5c; the editorial half is the riskiest (load-bearing behavior rules) and needs the operator's voice judgment + the lead-capture eval set + a full regression pass to adopt safely. Not done autonomously to avoid silently degrading Boondi. |
| **F7 — Interakt progress/typing sink** | **Held for operator (UX decision)** | Interakt/WhatsApp has no native typing indicator, so this means sending customers an interstitial "checking…" *message* per slow turn — a customer-facing UX choice (copy + whether to enable), not a clean bug-fix. The `sendProgressUpdate` plumbing exists; implementable on request. |

**Guardrail interaction (separate operator decision, 2026-06-11):** Boondi's
guardrail was made classifier-only (deterministic layer removed). That adds a
haiku classifier call to *every* turn, reversing the RC5 fast-path — a bare
"hi" goes from ~0.5s to ~1.5-11s under load. It compounds the case for F3
(dedicated key) and makes F7 (perceived-latency ack) more attractive if the
operator wants it.

---

## 4. Account-pressure note (RC2/F3, unchanged by decision)

The interrupted final run drove the shared OAuth window to `rejected` (the §2
diagnosis symptom, reproduced). The continuous `model.rate_limit` logging this
work adds is exactly the §3a mitigation: every latency sample now carries the
utilization it ran under, so before/after comparisons can be gated on
like-for-like windows. F3 (dedicated, properly-tiered API key) remains a
**pre-launch gate**, deferred by operator decision.

---

## 5. Evidence artifacts

- Baseline JSON: `/tmp/latency-baseline.json` (pre-fix, `allowed` window)
- After JSON: `/tmp/latency-after-clean.json` (all P1 fixes, `allowed` window)
- Instrumented core log: `/tmp/gantry-capture.log`
- Admin-panel proof: `http://localhost:3000/?c=conversation:wa:<phone>` for
  phones `000000041`–`000000044`
