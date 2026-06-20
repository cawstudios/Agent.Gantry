# Goal: Lean Model Choice Intelligence

Implement the smallest working model-choice system for Gantry.

Use the `ponytail` skill for the implementation discipline and the `autoreview`
skill for closeout. Keep the work boring: no new model-management platform, no
new dashboard, no new provider plugin system, no key versioning. Reuse existing
`modelAlias`, `agentHarness`, model catalog, `/v1/models/preview`,
`scheduler_list_models`, settings update flow, and credential commands.

## Problem

Agents need to choose the right model for jobs, tasks, and subagents without
relying on vague LLM judgment. The intelligence must come from runtime catalog
metadata and deterministic rules.

## Scope

Build only:

1. Settings-backed custom model aliases for existing providers.
2. A pure model recommendation helper over the merged catalog.
3. Agent-facing recommendation through existing model surfaces.
4. Validation that agent-selected job/task models use registered aliases and
   compatible harnesses.
5. Receipts showing chosen alias and reason.
6. A one-time built-in catalog refresh from official provider documentation.

Do not build:

- new model service
- new endpoint unless extending existing `/v1/models/preview` is clearly the
  smallest path
- model dashboard
- job-level harness
- conversation-level harness
- public `agentEngine`
- raw provider model IDs at public boundaries
- credential/key versioning
- runtime web scraping or automatic catalog sync

## Product Contract

Public vocabulary:

- `modelAlias`
- `agentHarness` / `agent_harness`
- `responseFamily`
- `modelRoute`
- `executionProviderId`
- `credentialProfileRef`

Agents choose explicit models only by registered alias.

Default behavior remains simple:

- omitted `modelAlias` = inherit/default
- explicit `modelAlias` = chosen alias
- jobs inherit bound agent harness
- subagents inherit parent model/harness unless host runtime validates a catalog
  alias override

## Catalog Refresh

Before implementing the chooser, refresh existing built-in model metadata from
official provider docs only.

Update only:

- context window
- input/output price per 1M tokens
- tool/thinking/cache support when documented
- supported workloads if repo assumptions changed
- `source.url`
- `source.verifiedAt`

Do not add runtime web fetching or scraping. The catalog is code/settings-owned.
Unknown price/context is allowed, but it must render as unknown and rank lower
for cost-sensitive recommendations.

## Technical Approach

Use the planner/decomposer prompts before coding:

- read `.codex/prompts/planner.md`
- read `.codex/prompts/decomposer.md`
- produce bounded tasks by capability, not file count

Implement a pure helper near the model catalog layer:

```ts
recommendModelAlias(input)
```

Inputs:

- workload
- agentHarness
- configuredProviders
- estimatedContextTokens optional
- requiresTools optional
- priority: `cheap | balanced | best`

Hard filters:

- unsupported workload
- incompatible `agentHarness`
- missing required tools
- context too small
- unknown/raw alias

Soft ranking:

- ready credential before missing credential
- `cheap`: lowest known input/output cost, unknown pricing last
- `best`: stronger reasoning/thinking/tool capability first
- `balanced`: ready + context fit + cost known
- parent/current alias wins ties for subagent/task use

Output:

- recommended alias
- reason string
- rejected candidates with short reasons, if useful for preview/tests

Expose through existing surfaces:

- extend `scheduler_list_models` with optional recommendation args
- extend existing model list/preview/CLI formatting only if needed
- keep no-arg behavior unchanged

## Acceptance Criteria

- Custom aliases can be declared in `settings.yaml` for existing providers only.
- Built-in and custom aliases resolve through the same catalog path.
- Raw provider model IDs are rejected unless registered as aliases.
- Agent-facing model listing can return:
  `Recommended model: <alias>. Why: <reason>.`
- Job creation/update rejects incompatible `modelAlias + agentHarness` before
  runner spawn.
- Credential update remains overwrite/rotate/disable only; no key versions.
- Receipts/job metadata record selected alias and reason for agent-chosen
  models.

## Surface Impact Matrix

| Surface | Status | Reason |
|---|---|---|
| Runtime behavior | Changed | Adds deterministic chooser and earlier validation. |
| `settings.yaml` | Changed | Stores custom aliases, no secrets. |
| Postgres/runtime projection | Read-only/observable | Can record selected alias/reason, not source of truth. |
| Control API | Changed | Only if extending existing preview/list is needed. |
| SDK/contracts | Changed | Only for documented recommendation/diagnostic shape; no `agentEngine`. |
| CLI | Changed | Only to show merged aliases/recommendation where already relevant. |
| Gantry MCP tools/admin skill | Changed | Extend existing scheduler/settings tools. |
| Channel/provider adapters | Unchanged by design | Selection happens before provider invocation. |
| Docs/prompts | Changed | Document chooser rules and user-visible copy. |
| Audit/events | Changed | Record alias/reason/credential update without secrets. |
| Tests/verification | Changed | Add focused tests below. |

## Required Tests

Add or update focused tests for:

- settings custom alias parse/render/export
- catalog merge built-in + settings aliases
- raw provider model ID rejection
- recommendation helper hard filters
- recommendation helper ranking for `cheap`, `balanced`, `best`
- `scheduler_list_models` recommendation output
- job model validation against bound `agentHarness`
- credential `set` / `rotate` / `disable` stays non-versioned

## Validation Commands

Run focused checks first:

```bash
npm run test:unit -- apps/core/test/unit/models/model-catalog.test.ts apps/core/test/unit/models/model-catalog-availability.test.ts apps/core/test/unit/runner/mcp/scheduler-tools.test.ts apps/core/test/unit/control/model-agent-preview.test.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/settings-desired-state-service.test.ts
npm run typecheck
npm run lint
npm run format:check
python3 .codex/scripts/check_architecture.py
```

Then run repo gates if the change is non-trivial:

```bash
npm test
python3 .codex/scripts/verify.py
python3 .codex/scripts/check_task_completion.py
```

## Review Closeout

Before final response, finish reviews using the `autoreview` skill.

Run the installed autoreview helper:

```bash
<autoreview-helper> --mode local
```

Rules:

- Treat review output as advisory.
- Verify every accepted finding by reading the real code path.
- Reject speculative rewrites and over-engineered fixes.
- If review-triggered fixes change code, rerun focused tests and rerun
  autoreview.
- Stop only after autoreview reports no accepted/actionable findings, or clearly
  document any consciously rejected finding.

Keep using Ponytail through review fixes: smallest correct fix, no new
abstractions, no cleanup outside this task.

## Closeout

Final response must include:

- changed files
- validation commands and results
- autoreview command and clean result
- accepted/rejected review findings, if any
- anything intentionally deferred
