# Manipal / Agent.Tender Change Audit

Date: 2026-07-18
Target branch: `main`
Reviewed working branch: `manipal-v2`

## Outcome

The Agent.Gantry changes were reviewed against both
`manipal-tender-copilot` and `Agent.Tender/new-setup`, then refactored without
changing the intended architecture.

No complete feature cluster could be removed without breaking a required
Manipal or Agent.Tender workflow. The final work therefore keeps the required
capabilities, removes accidental and duplicate code, corrects several contract
bugs, and moves cohesive logic behind existing boundaries so the PR does not
need new architecture exceptions or larger file-size budgets.

No Manipal source file was changed. Agent.Tender was only synchronized to the
canonical pending-interaction event contract and given a focused integration
test.

## Architecture That Remains Unchanged

The reviewed changes preserve these ownership rules:

- Manipal owns tenant and workspace state, authorization, model aliases,
  provider-secret deployment, worker orchestration, durable cursors/inbox/
  outbox state, and application delivery.
- Agent.Tender is an in-process Manipal package. It owns tender prompts,
  skills, contracts, orchestration, and app-scoped Gantry reconciliation.
- Only Agent.Tender calls `@gantry/sdk`.
- Gantry remains one separate, private, provider-neutral runtime using
  `GANTRY_PROCESS_ROLE=all` on port `3939`.
- Runtime results flow through Gantry's durable SDK event stream. No direct
  Gantry database access, embedded runtime, callbacks, webhooks, sidecars, or
  polling were introduced for the Manipal integration.
- Gantry does not acquire tender-domain behavior or vocabulary.

No architecture-map rule, provider exception, layer exception, or line-budget
exception was added or relaxed.

## Cross-Repository Requirement Trace

| Change cluster                                         | Required functionality                                                                                                                  | Could it be removed or replaced more cheaply?                                                                                             | Decision                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| App-owned named agents and session execution context   | Manipal passes its Gantry application ID, and Agent.Tender reconciles stable named agents before opening conversations or jobs.         | Reusing Gantry's default local agent would mix app identity, workspace identity, and configuration ownership.                             | Keep.                              |
| Exact tool, skill, and MCP bindings                    | Tender flows must pin the precise capability set, including required skill content hashes and Firecrawl MCP provenance.                 | Prompt-only instructions cannot enforce or audit an exact runtime binding.                                                                | Keep.                              |
| Model aliases, typed credentials, and per-run controls | Manipal chooses aliases and deploys secrets; Gantry resolves the selected provider and applies effort, thinking, and output controls.   | Direct provider calls from Manipal or Agent.Tender would bypass the required Gantry boundary.                                             | Keep.                              |
| Durable app runtime-event replay                       | Manipal must resume from a durable cursor and correlate events by app, session, job, and run.                                           | Callbacks, webhooks, polling, or process-local-only events conflict with the integration architecture and do not provide durable replay.  | Keep.                              |
| Caller-resolved native tools                           | Agent.Tender must receive `interaction.pending`, resolve a tool with the exact SDK `tool_use_id`, and allow the model turn to continue. | Returning a final-text approximation loses native tool semantics and correlation.                                                         | Keep.                              |
| Recurring job timezone and generation policy           | Manipal requires explicit timezone, coalesced misfires, skipped overlaps, and schedule generation metadata.                             | Relying on host defaults changes schedule behavior across deployments and cannot reject stale generations.                                | Keep.                              |
| Durable delegated tasks and `task_wait`                | Deep analysis uses keyed child tasks, parent job/run correlation, shared interaction budgets, recovery, and terminal waits.             | A synchronous nested call loses durable recovery, visibility, cancellation, and shared-budget enforcement.                                | Keep.                              |
| Stdio MCP audit proxy and pinned Firecrawl package     | Source discovery needs exact request/result correlation and deterministic MCP executable provenance.                                    | The Claude hook alone did not cover every stdio result correlation in live validation; runtime `npx` download alone is not deterministic. | Keep both the hook and proxy.      |
| `gantry_pgboss` schema                                 | Gantry's scheduler state must not collide with another pg-boss user in the same database.                                               | Keeping the generic `pgboss` schema risks cross-service ownership collisions.                                                             | Keep.                              |
| SDK/OpenAPI surface and version bump                   | Agent.Tender consumes typed agents, jobs, events, models, MCP servers, and interaction settlement methods.                              | Hand-written untyped calls would duplicate the contract and make drift harder to detect.                                                  | Keep generated and typed surfaces. |

## Lean Refactor Applied

### Removed or reduced

- Removed the accidental untracked `pnpm-workspace.yaml`.
- Removed duplicate Claude result diagnostics that repeated the later redacted
  result log.
- Removed raw error-result preview logging and kept a generic error message.
- Removed unused caller-tool completion fields, the unused initial model
  selection, and an unnecessary public SDK preview export.
- Consolidated the SDK changelog into one `0.5.0` entry.
- Restored dependency ordering so the only package change is the required
  pinned `firecrawl-mcp` dependency.
- Kept generated OpenAPI output rather than adding a parallel hand-maintained
  transport contract.
- Normalized the semantic diff so line-ending noise is not counted as product
  work.

### Extracted without changing behavior

The repository's existing file-size gate was restored by moving newly added,
cohesive behavior into neighboring modules. Important reductions include:

| File                          | Before refactor | After refactor | Extracted responsibility                                      |
| ----------------------------- | --------------: | -------------: | ------------------------------------------------------------- |
| Claude inline lane            |             725 |            656 | Caller-resolved MCP server adapter                            |
| Claude query loop             |             828 |            685 | MCP audit hooks, result normalization, and success ledger     |
| IPC task lifecycle dispatcher |             951 |            643 | Caller tool handling, delegated-task support, and `task_wait` |
| Async command task service    |             762 |            697 | Visible task queries and terminal waiting                     |
| Delegated agent task runner   |             747 |            696 | Terminal persistence and notification                         |
| Job execution                 |             851 |            830 | Exact required-skill selection                                |
| Job readiness service         |             792 |            735 | Readiness blockers                                            |
| OpenAPI schema registry       |             790 |            586 | Session and runtime-event schemas                             |
| pg-boss scheduler engine      |             704 |            680 | Stable schedule signature projection                          |
| Core tool registry            |             702 |            688 | Task descriptions moved beside tool schemas                   |

Other small overages were resolved with existing helpers or focused companion
modules. No budget was raised.

### Boundary corrections

- The application layer now receives the configured scheduling timezone through
  the existing schedule-planner port. The config-aware scheduler constructs the
  planner; application code no longer imports config.
- The workspace-folder length invariant lives in shared policy and is reused by
  platform, application, and control adapters.
- Bounded incremental SHA-256 audit hashing lives in shared code; application
  code no longer imports `node:crypto` directly.
- Transparent stdio child creation lives behind the approved sandbox adapter;
  the MCP audit proxy no longer calls `spawn` directly.
- Provider-specific test setup stays behind the provider boundary.
- Worker admission errors use provider-neutral wording.

## Correctness Fixes Found During the Audit

1. **Canonical pending-interaction event**

   The Claude inline lane emitted an unregistered
   `session.interaction.required` event, which the runtime forwarder silently
   discarded. It now emits canonical `interaction.pending` with `sessionId`.
   Session identity also participates in runtime-event deduplication.

   `Agent.Tender/new-setup` now listens for `interaction.pending`, resolves the
   interaction, and has a focused test proving settlement occurs before the
   final outbound answer.

2. **Delegated-task parent correlation**

   Job-spawned child tasks must populate `parentJobId` and `parentJobRunId`, not
   `parentRunId`. Non-job children populate only `parentRunId`. Keeping these
   paths mutually exclusive prevents foreign-key references from targeting the
   wrong run table.

3. **App-owned job-run identity**

   Job runs for a non-default app previously synthesized a default local agent
   from the workspace folder. They now reuse the job's stable app-owned agent,
   its current config version, and that config's LLM profile. Missing app-owned
   graph state fails closed instead of silently creating the wrong identity.

4. **Runtime-event stream failure backoff**

   Repeated subscription failures could hot-loop. The app runtime-event SSE
   pump now applies the same bounded retry delay already used by the session
   stream.

5. **Audit-data exposure**

   Claude SDK failures no longer place raw result previews in logs. MCP audit
   values retain bounded hashes and selected evidence projections instead of
   unrestricted payload text.

## Surface Impact

| Surface        | Final effect                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control API    | Adds app runtime-event list/stream, named-agent session context, interaction resolve/reject/cancel, credential, MCP, and job fields required by the SDK.    |
| SDK            | Publishes typed agents, access selections, models, credentials, MCP servers, job agent tasks, runtime-event streams, and interaction methods as `0.5.0`.    |
| Storage        | Preserves app/agent/config ownership on job runs and durable runtime-event filters. No app-local database or alternate storage architecture was introduced. |
| Scheduler      | Uses the isolated `gantry_pgboss` schema and persists explicit recurring policy metadata.                                                                   |
| Claude adapter | Supports exact caller-resolved tools and exact stdio MCP audit correlation while retaining the existing provider adapter boundary.                          |
| Runtime tasks  | Adds durable keyed delegation, `task_wait`, parent job/run lineage, terminal events, and shared caller-tool budgets.                                        |
| Deployment     | Pins `firecrawl-mcp@3.22.3` and retains the Docker PATH/startup hardening needed to execute the packaged MCP server.                                        |
| Manipal        | No source changes. Existing GraphQL/platform-state ownership is unchanged.                                                                                  |
| Agent.Tender   | Canonical event-name synchronization plus one focused client test; tender-domain ownership remains there.                                                   |

## Verification

Completed checks:

- `npm run typecheck` — passed.
- Gantry focused unit suites — 33 files, 486 tests passed.
- `npm run build --workspace @gantry/sdk` — passed.
- `npm run check:generated --workspace @gantry/sdk` — passed.
- Targeted ESLint over all refactored/new production files — passed with zero
  errors.
- `git diff --check origin/main` — passed.
- `npm audit --omit=dev` — zero production vulnerabilities.
- Agent.Tender `typecheck`, `build`, and tests — passed; 4 files, 24 tests.

The architecture checker reports no violation introduced by this change. Its
remaining findings are unchanged baseline/local-workspace debt:

- `apps/core/src/runtime/permission-classifier.ts` exceeds its pre-existing
  line budget.
- `apps/core/src/messaging/text-styles.ts` has pre-existing Telegram-specific
  path findings.
- Local empty `packages/agent-gantry/*` directories are not tracked PR content.

Full repository lint still reports seven pre-existing errors in files unchanged
by this PR, plus the repository's existing warning backlog. The changed-file
lint set is clean. The full root build remains non-portable on Windows because
the root clean script invokes Unix `rm -rf`; contracts, runtime typecheck, and
the SDK build were verified independently. A full unit-suite attempt also hits
existing Windows-only symlink, `/tmp`, and POSIX permission assumptions, so the
affected contract paths were verified with focused suites instead.

## Deliberately Deferred Risks

- Caller-resolved waiters and shared interaction-budget counters remain
  process-local. Making them restart-durable would require a new persistence
  design, which is outside this architecture-preserving refactor. Durable event
  and task records remain authoritative, but an in-flight waiter must be retried
  after process loss.
- The repository-wide baseline architecture/lint findings above should be fixed
  separately so they do not obscure this integration's gate status.

## Final Decision

Keep the functional Agent.Gantry changes. They are required by the current
Manipal and Agent.Tender contracts. The safe path to a lean main-branch PR is
the refactored version: accidental files and duplicate diagnostics removed,
correctness gaps closed, new behavior split along existing ownership
boundaries, and no architectural exception added.
