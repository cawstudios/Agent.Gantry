# Boondi Latency, Eager KB, And Template_BA Regression Plan

> For agentic workers: REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` for implementation tasks that can run independently, or `superpowers:executing-plans` for inline execution. This file is a planning artifact, not proof.

## 1. Goal

Define the exact outcome.

- In scope:
  - Remove `disclosure: progressive` from real Boondi domain `SKILL.md` files so Boondi KB/skills can be eagerly available instead of spending live LLM turns on skill loading.
  - Preserve Boondi tone as a hard non-negotiable constraint.
  - Prioritize gifting behavior first because the internal gifting demo is tomorrow.
  - Move Shopify product recommendations toward cache-only customer-turn search with background refresh, no live Shopify fallback.
  - Make Shopify product-search payloads lean: `title`, `priceMin`, `priceMax`, `currency`, and `url`, with `handle` retained internally or returned only if needed to build the URL.
  - Run and review all 59 `Template_BA` scenarios from `agents/boondi_support/evals/template-ba-live-scenarios.json`.
  - Tune local test throughput by using one Gantry core/runtime and increasing worker/concurrency counts, not by starting multiple cores.
- Out of scope:
  - Rewriting Boondi's soul, brand voice, or full prompt architecture from scratch.
  - Replacing all CRM payload contracts in the same slice; CRM payload slimming is planned as a follow-up unless it blocks the 59-case regression.
  - Building a complex semantic product search engine before proving simple local catalog search is insufficient.
  - Guaranteeing live stock or checkout success from cached product data.
- Success means:
  - Gifting scenarios pass first with Boondi's tone intact.
  - All 59 Template_BA scenarios are executed live through signed webhook input, not only dry-run or static review.
  - Every one of the 59 live scenarios has latency inspected from runtime trace evidence and semantic user-response quality reviewed against the scenario intent.
  - All 59 Template_BA scenarios pass the automated review script plus manual semantic review for Boondi tone, route correctness, unsupported promises, and customer usefulness.
  - Best-case target: normal replies complete under 8-10 seconds.
  - Worst acceptable case: any individual reply must complete within 15 seconds.
  - Any live scenario above 15 seconds is a failed row until the trace explains and fixes or explicitly accepts the cause.
  - Live traces show fewer avoidable LLM turns, no customer-turn skill-load loop, and local-cache product search latency.
  - `search_products` makes zero Shopify network calls during customer turns.
  - One scenario fix does not regress another scenario, proven by focused group reruns plus the full 59-case pass.
- Non-goals:
  - No customer-facing wording should mention MCP, KB, source tools, guardrails, traces, cache, or internal routing.
  - No prompt bulk dump that makes Boondi generic, stiff, or off-brand.

## 2. Current Evidence

Record what is known before proposing changes.

- Code evidence:
  - Real progressive domain skills currently include:
    - `agents/boondi_support/skills/boondi-gifting/SKILL.md`
    - `agents/boondi_support/skills/boondi-orders/SKILL.md`
    - `agents/boondi_support/skills/boondi-product-care/SKILL.md`
    - `agents/boondi_support/skills/boondi-store-aggregator/SKILL.md`
    - `agents/boondi_support/skills/boondi-misc-policy/SKILL.md`
  - `agents/boondi_support/evals/template-ba-live-scenarios.json` declares `scenarioCount: 59` and points to `/Users/caw-d/Downloads/Boondi_Intent_Scenario_Template.xlsx#Template_BA`.
  - `agents/boondi_support/evals/run-template-ba-live.ts` supports `--all`, `--group`, `--id`, `--limit`, unique phone generation, and evidence output.
  - `agents/boondi_support/evals/review-template-ba-evidence.ts` supports `--expect-count 59` and checks internal leakage, forbidden tools, scenario-specific reply patterns, and tool policy.
  - `packages/mcp-shopify/src/tools/search-products.ts` already exposes `search_products` and uses `ProductSearchCache`, but that cache is query-result based and still permits live Shopify calls.
  - `packages/mcp-shopify/src/shopify/queries.ts` currently fetches product descriptions, tags, inventory, images, and nested price data for product search.
  - `packages/mcp-shopify/src/tools/shared.ts` already maps `onlineStoreUrl`, `priceRangeV2`, and inventory-derived availability.
- Existing runtime/live evidence:
  - Screenshots from this session show product tool calls are usually smaller than LLM provider wait, but live Shopify search can still add 0.5s to 2.3s and create variance.
  - A live Shopify GraphQL Admin `products` call in this session returned active product data with `title`, `handle`, `onlineStoreUrl`, and `priceRangeV2` in about 1.6s.
  - Active runtime settings at `/Users/caw-d/gantry/settings.yaml` currently include `runtime.queue.max_message_runs: 3`, `runtime.warm_pool.size: 3`, `runtime.warm_pool.max_bound_workers: 3`, and `runtime.warm_pool.cache_prewarm_enabled: true`.
  - Codex can run the existing signed-webhook live scenario runner, inspect the generated evidence JSON, inspect trace timing, and perform semantic review of the outbound Boondi replies.
- Existing payload/log/trace evidence:
  - The latency traces shown in this session indicate repeated main LLM turns dominate several slow replies.
  - Prior trace surfaces expose queue, assistant startup, main LLM turns, tool calls, cache prewarm, and payload size details.
- Existing transcript/output evidence:
  - `agents/boondi_support/docs/boondi-intent-scenario-playbook.md` maps the full `Template_BA` scenario set and marks rows as static mapped until live proof exists.
  - The attached HTML docs are references for Boondi user journey, soul, and orchestration, but not runtime proof.
- Assumptions not yet proven:
  - Removing `disclosure: progressive` will reduce live skill-load LLM turns for the current runtime path without making first-call provider wait worse overall.
  - Eager skill bodies will fit within an acceptable prompt/cache profile for Boondi's selected model and warm pool shape.
  - Cache-only product search can meet gifting demo quality without live Shopify fallback.
  - Current local matching over title/handle/tags is enough for the 59 scenarios.
- Open questions:
  - The exact worker count for full 59-case parallel testing should be chosen after a dry run and rate-limit check. Start from current `3` and increase only if traces show idle capacity.
  - Whether manual Shopify catalog refresh should ship as CLI only, admin tool, or local script in the first implementation slice.
  - Whether to treat 10-15 second replies as warnings or soft failures after the first full live run. Initial rule: mark them as latency warnings and prioritize fixes by demo-critical scenarios first.

## 3. Source Of Truth

- Code is the source of truth.
- Runtime/live behavior is the acceptance proof for user-facing behavior.
- Docs, MD files, spreadsheets, HTML references, and prior notes are references, not proof.
- If docs disagree with code or observed behavior, fix docs after proof.
- Boondi tone is a source-of-truth constraint from `agents/boondi_support/SOUL.md` and must survive every latency optimization.

## 4. Ownership Boundary

Explain where each responsibility belongs.

- Runtime/framework owns:
  - Skill materialization semantics, SDK payload shape, warm worker lifecycle, queue concurrency, trace sections, and provider cache prewarm.
  - Enforcing the maximum LLM/tool-loop budget where possible.
- Product/domain/agent owns:
  - Boondi scenario behavior, gifting priority, tone, handoff style, and customer-safe route decisions.
- Prompt files own:
  - Compact always-on rules and Boondi voice boundaries.
  - They must not become long scenario dumps.
- Skill/KB files own:
  - Eagerly available domain playbooks for product care, gifting, orders, store/aggregator, and misc policy.
  - Removing `disclosure: progressive` is allowed for real domain skills in this latency slice.
- MCP/tool contracts own:
  - Shopify catalog cache, cache-only product search, lean product payloads, and Shopify refresh errors.
  - CRM compact response cleanup later, unless a CRM output breaks Template_BA.
- Config owns:
  - Runtime worker/concurrency tuning and optional catalog refresh interval/cache path/storefront base URL.
  - Any changes to `/Users/caw-d/gantry/settings.yaml` must be recorded and reverted or retained intentionally.
- Docs own:
  - The plan, evidence notes, and post-proof behavior docs.
- Must not be duplicated:
  - Scenario truth must stay in `template-ba-live-scenarios.json` and the workbook/playbook references, not be copied into prompt files.
  - Shopify catalog truth must be the persisted catalog cache refreshed from Shopify, not embedded in prompts.
  - Boondi tone must stay in `SOUL.md`, not scattered as one-off fixes.

## 5. Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Eager skill loading changes first-call payload shape and should remove customer-turn Skill load loops. Worker/concurrency settings may be tuned for 59-case testing. |
| `settings.yaml` | Changed | Local active runtime may need worker/concurrency changes and optional Shopify catalog cache settings. Record exact before/after values. |
| Postgres/runtime projection | Read-only/observable | Trace, message, and runtime-event evidence are inspected. Catalog cache should not require Postgres in the first slice unless existing runtime storage is clearly better. |
| Control API | Deferred | Manual catalog refresh through Control API is useful but not needed before the gifting demo. Use a package-local script or MCP startup refresh first. |
| SDK/contracts | Changed | SDK skill exposure and MCP product response shape are affected, but public tool name can remain `search_products`. |
| CLI | Deferred | A manual refresh CLI is useful after the first cache-only implementation proves itself. Avoid adding CLI before core behavior is validated. |
| Gantry MCP tools/admin skill | Unchanged by design | Product catalog refresh is Shopify MCP owned; Gantry admin tools should not grow Boondi-specific product behavior. |
| Channel/provider adapters | Read-only/observable | Interakt webhook flow and provider timing traces are used for proof, but adapters should not change unless evidence shows a delivery bug. |
| Docs/prompts | Changed | Remove progressive skill metadata, update Boondi docs if proof changes runtime guidance, and keep SOUL/CLAUDE tone compact. |
| Audit/events | Changed | Catalog refresh success/failure and cache age should be logged or traced. |
| Tests/verification | Changed | Add unit checks for eager skill metadata removal, cache-only product search, lean payload shape, and full 59-case live regression evidence. |

## 6. Phase Plan

Each phase must update status before moving to the next phase.

### Phase 0: Baseline

- Status: Not started.
- Objective:
  - Capture the exact current behavior before edits.
  - Confirm the 59-case manifest and runner are healthy.
  - Preserve the current dirty worktree by not reverting unrelated changes.
- Changes allowed:
  - Read-only commands.
  - Create evidence files under a temporary path or `agents/boondi_support/evals/` if needed.
- Evidence required:
  - `git status --short` before changes.
  - `npx tsx agents/boondi_support/evals/run-template-ba-live.ts --dry-run --all`
  - `node` or `rg` check that the manifest has 59 scenarios and no duplicate ids.
  - Baseline targeted gifting dry run selection:
    - `npx tsx agents/boondi_support/evals/run-template-ba-live.ts --dry-run --group gifting`
  - Current active runtime concurrency snippet from `/Users/caw-d/gantry/settings.yaml`.
- Regression risk:
  - Low, no implementation changes.
- Reviewer decision:
  - Proceed only when the manifest and runner selection are valid.

### Phase 1: Eager Boondi KB/Skill Loading

- Status: Not started.
- Objective:
  - Remove live LLM skill-load loops by making Boondi domain skills eagerly available.
  - Keep Boondi tone unchanged.
- Changes allowed:
  - Remove the exact line `disclosure: progressive` from real domain skills:
    - `agents/boondi_support/skills/boondi-gifting/SKILL.md`
    - `agents/boondi_support/skills/boondi-orders/SKILL.md`
    - `agents/boondi_support/skills/boondi-product-care/SKILL.md`
    - `agents/boondi_support/skills/boondi-store-aggregator/SKILL.md`
    - `agents/boondi_support/skills/boondi-misc-policy/SKILL.md`
  - Update active Boondi docs that still describe those skills as progressive if they are current guidance.
  - Do not shrink or rewrite `SOUL.md` or `CLAUDE.md` in this phase unless a verified failure proves it is necessary.
- Evidence required:
  - `rg -n "disclosure:\\s*progressive" agents/boondi_support/skills`
  - Unit or payload-focused test proving selected skill bodies or expected eager content are available in the initial SDK payload.
  - Live focused run for one gifting scenario and one non-gifting scenario showing no `Skill` tool load section before the reply.
  - Trace comparison: LLM turn count, provider wait, cache read/write tokens, and payload size.
- Regression risk:
  - Medium. Eager context may increase first-call size or shift model behavior.
- Reviewer decision:
  - Proceed only if the focused trace shows fewer avoidable LLM turns without tone degradation.

### Phase 2: Gifting Demo First

- Status: Not started.
- Objective:
  - Stabilize gifting behavior before broad scenario cleanup.
  - Treat gifting as top priority for the internal demo tomorrow.
- Changes allowed:
  - Surgical fixes in Boondi gifting skill/KB, Shopify product suggestion path, and handoff wording.
  - No broad prompt rewrites.
  - No scenario-specific hardcoding that only passes one row.
- Evidence required:
  - Run all gifting rows from the manifest:
    - `npx tsx agents/boondi_support/evals/run-template-ba-live.ts --group gifting --out /tmp/boondi-template-ba-gifting-evidence.json`
    - `npx tsx agents/boondi_support/evals/review-template-ba-evidence.ts --evidence /tmp/boondi-template-ba-gifting-evidence.json`
  - Manual review of gifting replies for:
    - website-first under-25 path
    - max 3 product suggestions
    - warm occasion acknowledgement
    - no quote, delivery, stock, or customization guarantees
    - no internal process words
  - For any gifting fix, rerun the touched scenario, all gifting scenarios, and at least one nearby non-gifting smoke row.
- Regression risk:
  - High because gifting rules overlap with product search, customization, bulk handoff, and CRM follow-up.
- Reviewer decision:
  - Gifting must pass before lower-priority rows are optimized.

### Phase 3: Shopify Product Cache-Only Search

- Status: Not started.
- Objective:
  - Remove live Shopify product-search latency from customer turns.
  - Serve product recommendations from a persisted catalog cache refreshed outside the customer path.
- Changes allowed:
  - Add a catalog cache module under `packages/mcp-shopify/src/tools/` or `packages/mcp-shopify/src/shopify/` with one clear responsibility.
  - Add a background refresh path on MCP startup.
  - Keep existing `search_products` tool name, but change implementation to local cache only.
  - Lean output to `title`, `priceMin`, `priceMax`, `currency`, `url`; keep `handle` internal unless response URL fallback needs it.
  - Use Shopify `products` GraphQL pagination for first implementation. Consider bulk operations later only if catalog size requires it.
- Evidence required:
  - Unit test where `search_products` returns cached products and a mocked Shopify client is not called.
  - Unit test for missing cache returning a safe empty product result, not live fallback.
  - Unit test for refresh failure preserving last good cache.
  - Payload test proving no `id`, `available`, images, descriptions, raw `priceRange`, or internal `replyContract` fields in the default product recommendation output.
  - Live trace proving product search is local-cache latency and has zero Shopify network call in the customer turn.
- Regression risk:
  - Medium. Product search quality can degrade if local matching is too simple.
- Reviewer decision:
  - Proceed when gifting scenarios using products still pass and traces prove no live Shopify fallback.

### Phase 4: Worker And Parallel Regression Setup

- Status: Not started.
- Objective:
  - Run the 59-case regression quickly without starting multiple runtime cores.
- Changes allowed:
  - Tune `/Users/caw-d/gantry/settings.yaml` only after recording current values.
  - Keep one Gantry core/runtime process.
  - Increase worker/concurrency values cautiously:
    - `runtime.queue.max_message_runs`
    - `runtime.warm_pool.size`
    - `runtime.warm_pool.max_bound_workers`
    - keep `runtime.warm_pool.cache_prewarm_enabled: true`
  - Use unique generated phones from the runner to avoid cross-scenario state collisions.
- Evidence required:
  - Before/after settings snippet.
  - `gantry status` or equivalent process check showing one core/runtime.
  - Runner evidence showing selected scenarios use unique phones.
  - Latency trace sample from parallel run showing queue is not the bottleneck and no rate-limit failure pattern.
- Regression risk:
  - Medium. Too much parallelism can create provider wait spikes, rate limits, or noisy tool timing.
- Reviewer decision:
  - Cap workers at the highest stable setting observed in dry/focused runs. Do not use parallelism to hide broken behavior.

### Phase 5: Full Template_BA Regression

- Status: Not started.
- Objective:
  - Prove one fix does not break another scenario by running all 59 scenarios live through signed webhooks and reviewing latency plus semantic response quality.
- Changes allowed:
  - Only small targeted fixes based on failed evidence rows.
  - Every fix must declare which scenario or group it intends to affect.
- Evidence required:
  - Full run:
    - `npx tsx agents/boondi_support/evals/run-template-ba-live.ts --all --out /tmp/boondi-template-ba-full-evidence.json`
  - Full review:
    - `npx tsx agents/boondi_support/evals/review-template-ba-evidence.ts --evidence /tmp/boondi-template-ba-full-evidence.json --expect-count 59`
  - Semantic review pass by Codex over all 59 evidence rows:
    - customer reply answers the actual scenario intent
    - Boondi tone is warm, concise, premium, and not generic
    - gifting rows preserve gifting priority and website-first behavior where applicable
    - no internal terms, tool narration, cache narration, or process leakage
    - no unsupported promises for delivery, stock, customization, discounts, refunds, or quotes
  - Latency review pass by Codex over all 59 evidence rows:
    - end-to-end `replySeconds` or trace total captured
    - replies under 8 seconds marked `good`
    - replies from 8 to 10 seconds marked `acceptable target band`
    - replies from 10 to 15 seconds marked `warning`
    - replies above 15 seconds marked `failed latency gate`
    - number of main LLM turns recorded
    - tool stages and tool durations recorded
    - product-search rows confirm local cache behavior once cache-only search is implemented
    - rows above the latency target are tagged with likely cause: queue, startup, provider wait, tool call, or hand-off overhead
  - For each failed row:
    - inspect outbound text
    - inspect trace timing and tool stages
    - identify whether failure is tone, route, unsupported promise, missing data, wrong tool, payload bloat, or latency
    - patch smallest owner-owned surface
    - rerun the single row
    - rerun its group
    - rerun the full 59 before final acceptance
- Regression risk:
  - High. Fixes for product-care, delivery, orders, and gifting can interact through shared prompt/context and tool surfaces.
- Reviewer decision:
  - Accept only when the full review passes and manual tone spot checks pass.

### Phase 6: Final Gate

- Status: Not started.
- Objective:
  - Package proof and leave the repo/runtime in an intentional state.
- Changes allowed:
  - Documentation updates and evidence summary.
  - Revert temporary local worker settings if they were testing-only.
- Evidence required:
  - `npm run test:unit -- packages/mcp-shopify/test/unit/tools/products-inventory-discount.test.ts`
  - Any new focused unit tests added for catalog cache and skill eager loading.
  - `npm run typecheck` if TypeScript contracts changed.
  - Full `Template_BA` evidence path and review output.
  - Trace summary with before/after LLM turn count and product search latency.
  - Cleanup search:
    - `rg -n "disclosure:\\s*progressive" agents/boondi_support/skills`
    - `rg -n "available|replyContract|replyFacts|priceRange" packages/mcp-shopify/src/tools/search-products.ts packages/mcp-shopify/test -S`
- Regression risk:
  - Medium, mostly from config drift or stale docs.
- Reviewer decision:
  - Approve only if behavior, latency, and tone evidence all pass.

## 7. Testing Strategy

Start cheap and deterministic. Spend live LLM/API/runtime calls only after static evidence shows the change is likely worth testing.

- Static/code checks:
  - `rg -n "disclosure:\\s*progressive" agents/boondi_support/skills`
  - Manifest validation through `run-template-ba-live.ts --dry-run --all`.
  - Payload shape unit tests for Shopify product output.
- Unit/integration checks:
  - Shopify catalog cache tests.
  - Skill eager-loading/payload-shape tests at the runner/materializer seam.
  - Existing MCP Shopify tests touched by product payload changes.
- Minimal focused live/runtime tests:
  - One gifting product recommendation.
  - One bulk/customization gifting handoff.
  - One product-care detail lookup.
  - One order/status scenario if runtime changes touch tool loop behavior.
- Cross-scenario regression:
  - Full 59-case `Template_BA` live webhook run and automated review.
  - Full 59-case Codex semantic response review.
  - Full 59-case Codex latency review.
  - After any fix, rerun single row, group, and final full suite.
- Payload/log/trace checks:
  - LLM turn count.
  - End-to-end reply latency with target band under 8-10 seconds and hard maximum 15 seconds.
  - provider wait and generation timing.
  - provider cache read/write.
  - tool call count and payload bytes.
  - product cache hit/miss and cache age.
- Output/reply checks:
  - Boondi tone preserved.
  - Reply is semantically correct for the scenario, not merely regex-compatible.
  - Gifting is warm, premium, concise, and website-first where required.
  - No unsupported promises.
  - No internal terminology.
- Tool/MCP trace checks:
  - No `mcp_list_tools`.
  - No live Shopify product call inside `search_products` customer turn.
  - Shopify order/discount tools still allowed only where expected.

Testing choice for this task:

- Because the user explicitly asked to test all 59 `Template_BA` cases, this plan requires full live testing for final acceptance.
- Static checks, dry runs, and automated review are not enough for success. Final success requires Codex to inspect all 59 live webhook evidence rows for latency and semantic user-response quality.
- During development, use minimal focused live tests until the specific fix is ready for full regression.

## 8. Live Acceptance Criteria

Use this section because the change affects live/customer-facing behavior and external runtime behavior.

- Signed webhook/API call passes when applicable.
- Runtime payload/log/trace is inspected.
- User/customer-visible output is inspected.
- Tool/MCP usage is inspected.
- No internal/process leakage.
- No unsupported promises.
- No broad unnecessary MCP/tool fanout.
- Evidence file paths are stored in this plan or a linked evidence note after execution.

Evidence table:

| Scenario | Runtime evidence | Payload/log evidence | Output evidence | Decision |
| --- | --- | --- | --- | --- |
| Gifting focused run | Required before broad fixes | Required: LLM turns, product cache, tool stages | Required: tone/manual review | Not started |
| Shopify cache-only product search | Required before full 59 | Required: zero live Shopify search fallback | Required: lean product suggestions | Not started |
| Full Template_BA 59 | Required final gate for all rows: signed webhook result, reply received, latency trace, under-8/10/15s band | Required for all rows: automated review output, LLM turns, tool stages, latency cause tags for warning/failed rows | Required for all rows: Codex semantic review, no internal leaks, Boondi tone preserved | Not started |

## 9. Token, Cost, And Rate-Limit Discipline

- Reuse existing evidence before generating new evidence.
- Do not run broad live suites after every small edit.
- Keep prompts, skills, KBs, and docs compact.
- Avoid solving behavior by dumping scenario examples into always-on context.
- Prefer deterministic checks before LLM/API calls.
- Cap parallel live testing to avoid noisy failures and rate-limit collisions.
- Eager loading is accepted only if measured total latency improves or removes repeated LLM turns without damaging tone.
- Use one runtime core and increase workers only after dry-run/focused evidence.

## 10. Rollback And Cleanup

- Old path removed:
  - Remove progressive disclosure from real Boondi skill metadata.
  - Remove live Shopify fallback from `search_products` customer-turn path.
- Duplicate source removed:
  - Do not duplicate Template_BA scenario bodies into prompt files.
  - Do not duplicate product catalog data into prompt files.
- Docs updated:
  - Update active Boondi docs that claim these skills are progressive after proof.
  - Leave historical plan references alone unless they are active instructions.
- Stale references searched:
  - `rg -n "disclosure:\\s*progressive|progressive skill|progressively loaded" agents/boondi_support -S`
  - `rg -n "replyContract|replyFacts|available|priceRange" packages/mcp-shopify/src packages/mcp-shopify/test -S`
- Generated artifacts handled:
  - Evidence files under `/tmp` can stay temporary.
  - Repo evidence files must avoid secrets and large generated payload dumps.
- No commit/stage unless explicitly requested:
  - Do not stage existing unrelated dirty files.
  - If committing later, commit only files intentionally changed for this plan.

## 11. Self-Review

- Is this the simplest correct architecture?
  - Yes. Eager skill availability plus cache-only product search directly targets the observed latency drivers without introducing a broad new runtime.
- Is the ownership boundary clean?
  - Yes. Boondi owns tone and domain skills; Shopify MCP owns product catalog cache; Gantry runtime owns worker, queue, skill materialization, and traces.
- Is any workaround disguised as long-term design?
  - Risk: manual refresh can be a temporary path. Long-term refresh should be owned by Shopify MCP startup/background scheduling.
- Is there any duplicate source of truth?
  - The plan avoids prompt-embedded scenarios and prompt-embedded product catalog data.
- Is context/prompt pollution controlled?
  - The plan permits eager skills but requires payload-size and provider-cache evidence before acceptance.
- Is live/runtime proof strong enough for the risk?
  - Final proof requires all 59 live cases plus trace review.
- Could this fix one scenario while breaking another?
  - Yes, which is why every fix must rerun single row, group, and final full suite.
- Are token, cost, and rate-limit costs justified?
  - Yes for the final 59-case pass because the user explicitly requested it and the internal gifting demo is near.
- Is cleanup explicit?
  - Yes, including progressive metadata search, payload-field search, generated artifacts, and config state.

## 12. Final Reviewer Decision

- Approved: Not yet.
- Approved with changes: Not yet.
- Blocked: Not yet.
- Reason:
  - Plan is ready for review. Implementation should begin only after confirming execution mode and whether temporary active runtime settings should be retained or reverted after the 59-case run.
- Next action:
  - Start Phase 0 baseline, then Phase 1 eager skill metadata change, then Phase 2 gifting-first validation.
