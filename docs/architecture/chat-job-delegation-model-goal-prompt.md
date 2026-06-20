# Chat-First Async Work Goal Prompt

Use this prompt to implement Gantry's async work model without shipping dormant
task tables, fake delegation, or raw provider async tools.

```text
/goal Implement the simplest complete Gantry async work slice: chat-first runtime admission plus a durable Task lifecycle for real async command execution. Do not expose delegated subagent tools until the same lifecycle can launch, read, cancel, recover, and receipt delegated work end to end.

This is an implementation goal. Make code, tests, docs, prompts, runtime
verification, PR, and CI changes as needed. Search official provider docs when
provider behavior matters. The goal is not complete until local runtime and CI
evidence pass.

Product model:
- Agent: durable identity, prompt/profile, selected capabilities, attached
  sources, default `modelAlias`, and `agentHarness`.
- Recurring Job: durable schedule and policy that creates JobRuns. It is not a
  Task.
- Job: manual or one-time background trigger that targets an agent and may
  choose a catalog `modelAlias` under model policy.
- JobRun: one scheduled or manual execution attempt for a Job or Recurring Job.
  A JobRun may create child Tasks.
- Task: Gantry-owned async work item with durable row, public status,
  cancellation, audit, recovery, and terminal receipt.
- Run: one execution attempt that owns lease/fence, provider session/correlation,
  and terminal evidence.
- Subagent: adapter-private execution strategy behind a Gantry Task. It is never
  a public authority surface by itself.

One-sentence product contract:
Gantry users can start approved long-running work, get a Gantry task id, check
status after restart, cancel it, and receive one durable receipt; provider task
ids and raw provider tools stay private.

Reconciled product decision:
- The simple full V1 is `async_command`, not public delegated subagents.
- Reason: async command work is the smallest real executor that can prove the
  Gantry Task lifecycle: row before spawn, existing command authority, sandbox,
  read/list after restart, terminal-first cancel, recovery, and receipts.
- Public delegated subagents are the next wave after the Task lifecycle is
  proven. Shipping `delegate_task` first would either fake provider parity or
  expose a preview/provider-specific path before Gantry owns cancellation,
  recovery, and receipts.
- The durable Task kernel must support future `delegated_agent`, but V1 must not
  claim delegated-agent support until Anthropic and DeepAgents executors pass the
  same gate.

Locked V1 scope:
- Implement chat-first admission/status copy and host-capacity clamping only as
  needed to keep chats from being blocked by jobs/tasks on a local machine.
- Implement one durable Task model in Postgres for `async_command`.
- Expose only these public Gantry MCP tools when they are backed by the real
  executor/read path:
  - `async_run_command`
  - `task_get`
  - `task_list`
  - `task_cancel`
- Do not expose `delegate_task` or `task_update` in V1.
- Do not add dormant handlers, unavailable public tools, or unused database
  tables. A task row is allowed only when the implementation also creates it
  before launch, claims/runs work, reads status, cancels, recovers, and writes
  terminal evidence.
- Keep raw provider async tools hidden:
  - Anthropic/Claude: raw `Agent`, `Task`, `TaskOutput`, `TaskStop`, `Monitor`,
    provider background Bash ids, output files, and raw SDK task messages.
  - DeepAgents: `task`, `write_todos`, `start_async_task`, `check_async_task`,
    `update_async_task`, `cancel_async_task`, and `list_async_tasks`.
- DeepAgents async subagents are not a V1 public surface. Keep the sentinel and
  exclusion tests only if they protect against accidental exposure. They are not
  acceptance evidence for delegation.
- Recurring jobs remain schedules over JobRuns. Tasks are only child async work
  created by a Run or JobRun.
- `.factory/run.json` showing phase `done` is planning evidence only. It is not
  implementation acceptance.

Explicitly out of scope for this PR:
- Public delegated subagents.
- `task_update`.
- Remote Agent Protocol transport.
- Pre-spawned sandbox pools.
- Browser tasks, external workflow tasks, and maintenance tasks.
- A Control API task-management surface.
- New `settings.yaml` keys.
- Horizontal scaling claims beyond the durable local lifecycle implemented here.

Documentation citations to refresh before implementation:
- Claude background Bash: https://code.claude.com/docs/en/interactive-mode#background-bash-commands
- Claude Agent/subagent behavior: https://code.claude.com/docs/en/tools-reference#agent-tool-behavior
- Claude SDK task lifecycle: https://code.claude.com/docs/en/agent-sdk/python
- DeepAgents async subagents: https://docs.langchain.com/oss/python/deepagents/async-subagents
- DeepAgents JavaScript `AsyncSubAgent`: https://reference.langchain.com/javascript/deepagents/middleware/AsyncSubAgent
- DeepAgents sync subagents: https://docs.langchain.com/oss/python/deepagents/subagents

Local repo citations to reread before editing:
- `README.md`
- `WORKFLOW.md`
- `docs/FACTORY.md`
- `docs/QUALITY.md`
- `docs/architecture/codebase-refactor-principles.md`
- `docs/architecture/current-verification-commands.md`
- `docs/architecture/runtime-components.md`
- `docs/architecture/autonomous-jobs.md`
- `docs/architecture/capability-management.md`
- `apps/core/src/domain/ports/task-lifecycle.ts`
- `apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts`
- `apps/core/src/runner/mcp/tools/task-lifecycle.ts`
- `apps/core/src/adapters/llm/deepagents-langchain/runner/gantry-shell-tool.ts`
- Current `.factory/run.json`, if present.
- Current `.factory/decomposition.json`, if present.
- Relevant scoped `AGENTS.md` files before editing each directory.

Exact UX contract:
- Never show users old worker/capacity queue internals in waiting copy.
- If chat admission is delayed past 30 seconds, show once per waiting episode:
  `Still starting this request.`
- Job delay copy: `Delayed: interactive capacity is reserved for chats.`
- Command authority missing: `This command is not approved for this agent. Request access or choose an approved capability.`
- Task created: `Started: <short task summary>`
- Cancel success: `Task was cancelled. Nothing else changed.`
- Already terminal: `Task is already finished and cannot be cancelled.`
- Provider-private detail requested: `Provider task details are internal. Use the Gantry task id to check status or cancel.`
- Unsupported delegated subagent request in V1: `Delegation is not available yet. Use async_run_command for approved command work.`
- Terminal receipt lines must be host-enforced:
  - `Completed: <short outcome>`
  - `Used: <tools/capabilities or none>`
  - `Changed: <files/accounts/channels or none>`
  - `Delegated: no`
  - `Needs attention: <blocker or none>`
- Operator status must show:
  - `Interactive capacity: <used>/<capacity>`
  - `Interactive backlog: <count>, oldest <seconds>s`
  - `Background jobs: <used>/<capacity>`
  - `Async tasks: <used>/<capacity>`
  - `Host capacity: <used>/<budget>, CPU threads <detected>`
  - `Sandbox warm template: available | unavailable, cache hit | miss`

Implementation requirements:

1. Admission and host budget
- Runtime classes:
  - `interactive`: live chat turns, continuations, approvals, questions.
  - `background`: scheduled/run-now jobs.
  - `task`: async command Tasks.
  - `maintenance`: memory dreaming, cleanup, bake/reconcile work.
- Chats must be admitted before jobs, tasks, and maintenance when capacity is
  constrained.
- Jobs and tasks must not consume live chat slots.
- No preemption in V1; do not kill running jobs to admit chats.
- Detect CPU capacity with `os.availableParallelism()` when available, falling
  back to `os.cpus().length`.
- Clamp effective live/job/task concurrency to a conservative local host budget.
  Existing settings remain desired upper bounds, not permission to oversubscribe.
- Expose detected CPU threads, effective host budget, backlog, job usage, task
  usage, and sandbox warm-template state in startup/status/operator evidence.

2. Durable task row
- Implement one runtime Postgres table for Tasks. Use the current naming pattern
  if the repo already has a canonical name; otherwise use `agent_async_tasks`.
- Required persisted fields:
  - public Gantry task id.
  - app id.
  - agent id.
  - conversation id and thread id when present.
  - parent run id and parent job/job-run id when present.
  - kind: V1 only `async_command`.
  - public status: `queued`, `running`, `needs_attention`, `completed`,
    `failed`, `cancelled`, `timed_out`.
  - admission class.
  - authority snapshot for the approved command/capability decision.
  - private execution correlation, including process/session handles required
    for recovery/cancel; never expose this in public DTOs.
  - lease token, fencing version, heartbeat, created/updated/started/terminal
    timestamps.
  - bounded summary, bounded output summary, error summary, and `receipt_json`.
- Task state is runtime Postgres state. Do not add Task state to `settings.yaml`.
- Every task write after launch must be lease/fence checked.
- Startup recovery must reconcile queued/running Tasks into a safe state:
  recover when possible, otherwise terminally fail with durable evidence.

3. Public task DTO
- Public DTOs expose only:
  - Gantry task id.
  - kind.
  - public status.
  - bounded summary.
  - receipt lines.
  - allowed next actions.
  - created/updated/terminal timestamps.
- Public DTOs must not expose provider task id, provider thread id, provider run
  id, output file path, child pid, raw SDK message, process group id, lease
  token, fencing version, or private correlation payload.

4. Async command execution
- `async_run_command` creates the durable Task row before spawning any process.
- Durable authority is exact scoped `RunCommand(<argv pattern>)` or a reviewed
  semantic capability that expands to scoped command authority.
- Reject bare persistent `Bash`, `RunCommand`, `Bash(*)`, `RunCommand(*)`,
  provider-native command tools, and leading-wildcard command scopes.
- Reuse the same command policy, sandbox, egress, environment scrub,
  protected-path, and audit rules as the current synchronous shell path. Do not
  add a second command policy.
- Command output must be bounded and summarized.
- Cancellation marks the Gantry Task terminal first, then kills the full process
  group or otherwise proves no child process outlives the task.
- Slot release must be exactly-once for success, failure, timeout, and cancel.

5. Tool exposure rule
- Mount `async_run_command`, `task_get`, `task_list`, and `task_cancel` only
  after their backing executor/repository/service path is implemented and
  tested.
- Keep `delegate_task` and `task_update` unmounted or hidden in this PR.
- If a model asks for delegation before V2, return the locked unsupported
  delegated-subagent copy and start no provider work.

6. Later delegation gate
- A later PR may expose `delegate_task` only after it satisfies the exact same
  durable contract:
  - task row before provider launch.
  - `AgentDelegation`/capability/model/harness checks before provider launch.
  - adapter-private provider correlation.
  - read/list/cancel/recovery/receipt.
  - stale-fence protection.
  - crash-window tests.
- DeepAgents async subagents may be used only when the installed package exposes
  the required APIs, the sentinel passes, and Gantry owns the Agent Protocol
  transport/executor. Otherwise fail closed and start no delegated work.
- Anthropic native Agent/Task/background Bash may be used only as adapter-private
  mechanisms behind the Gantry Task lifecycle.

Acceptance criteria:
- A chat can start while Knacklabs/background jobs are queued or running.
- Background jobs and async Tasks cannot consume live chat slots.
- Users never see worker/capacity wording.
- Saturated chat admission sends `Still starting this request.` at most once per
  waiting episode.
- Operators can see interactive capacity, backlog, host capacity/thread count,
  job capacity, async task capacity, and sandbox warm-template state.
- Host CPU/thread count is detected and used to clamp effective local
  concurrency.
- `async_run_command` creates a durable Task row before spawning a command.
- Denied command work never spawns a process.
- `task_get` and `task_list` return durable Gantry status after restart.
- `task_cancel` marks Gantry terminal first, kills child work, and prevents late
  stale writes.
- Terminal Tasks include the five receipt lines.
- Public task DTOs never expose provider/process/private correlation data.
- Cross-agent, cross-conversation, cross-thread, stale-run, missing-capability,
  malformed task-id, and terminal-task mutation cases fail closed.
- Crash recovery is verified for:
  - after task row create before spawn.
  - after spawn before running status.
  - after running before first progress.
  - after cancellation before process kill returns.
  - after terminal write before receipt/audit delivery.
- Recurring jobs remain schedules over JobRuns; they are never represented as
  Tasks.
- `delegate_task` and `task_update` are not exposed until their real executor
  path exists.
- Factory phase `done` is treated as planning/orchestration evidence only, not
  implementation acceptance.

Capability-driven task decomposition:
1. Contract cleanup slice
   - Update this prompt, scoped `AGENTS.md` guidance, and active docs to say V1
     is async command Tasks only.
   - Remove any claim that delegated subagents are public before the durable
     lifecycle exists.
   - Verify no docs instruct engineers to mount `delegate_task` or dormant
     `task_get`/`task_cancel`.

2. Admission/status slice
   - Implement chat-first admission, host budget clamp, friendly waiting copy,
     and operator status metrics.
   - Verify chat admission while job/task capacity is saturated.

3. Durable task storage slice
   - Add Task schema, migration, repository, DTO mapper, and fenced transition
     service.
   - Verify launch/list/get/cancel/progress/terminal transitions and private
     correlation redaction.

4. Async command executor slice
   - Wire `async_run_command` through existing command authority, sandbox,
     egress, protected-path, and audit policy.
   - Add process-group cancellation and exactly-once slot release.
   - Verify denied commands never spawn.

5. Public MCP tool slice
   - Mount only `async_run_command`, `task_get`, `task_list`, and `task_cancel`
     after slices 2-4 pass.
   - Keep `delegate_task` and `task_update` hidden.
   - Verify cross-scope access denials and DTO redaction.

6. Recovery/receipts slice
   - Add startup recovery and terminal receipt persistence.
   - Verify the required crash windows.

7. Runtime/job smoke slice
   - Build, restart local launchd runtime, confirm `gantry status`, trigger the
     existing Knacklabs lead generation job, and prove a chat can still start
     while background work is active.

8. Review/PR/CI slice
   - Run automated tester, deterministic verify, ponytail review, autoreview,
     commit, push, open PR, and fix CI until passing.

Build waves:
1. Private kernel only
   - Exit condition: a private durable `async_command` Task can be created,
     executed, read, cancelled, recovered after restart, and verified while all
     public async tools remain unmounted.
2. Admission safety
   - Exit condition: interactive work has reserved capacity and lower-priority
     jobs/tasks/maintenance cannot oversubscribe host budget.
3. First public async surface
   - Exit condition: `async_run_command`, `task_get`, `task_list`, and
     `task_cancel` are public and end-to-end for command Tasks only.
4. Delegated-agent gate
   - Exit condition: a later PR may expose `delegate_task` only when Anthropic
     and DeepAgents use the same durable Task lifecycle, unsupported update and
     preview/version/transport states fail closed, and raw provider tool names
     remain hidden.
5. Jobs and recovery
   - Exit condition: JobRuns can own child Tasks with durable recovery, clear
     setup blockers, model policy, and terminal evidence.
6. Docs and release evidence
   - Exit condition: docs and prompts match shipped behavior, cleanup searches
     pass, full verification/review/runtime evidence is recorded.

Surface Impact Matrix:
| Surface | Impact | Reason |
|---|---|---|
| Runtime behavior | Changed | Adds chat-first admission, host budget clamping, async command Task execution, cancellation, recovery, and receipts. |
| `settings.yaml` | Unchanged by design | V1 uses existing runtime queue/capability/model settings; Task rows are runtime state. |
| Postgres/runtime projection | Changed | Adds durable Task rows, fenced transitions, private correlation, receipts, and recovery state. |
| Control API | Deferred | V1 ships through MCP/runtime status only; direct API task management is not needed for the first complete slice. |
| SDK/contracts | Changed | Adds public Gantry Task DTO/status contract and redaction requirements. |
| CLI | Changed | `status` must show host/job/task/chat capacity evidence; no CLI task-management surface in V1. |
| Gantry MCP tools/admin skill | Changed | Mounts `async_run_command`, `task_get`, `task_list`, and `task_cancel` only after real backing implementation exists. |
| Channel/provider adapters | Read-only/observable | Channels may render neutral task/status/receipt copy; provider async subagents remain hidden. |
| Docs/prompts | Changed | Removes broad delegation promises and documents the simple full V1 plus later delegation gate. |
| Audit/events | Changed | Emits task launch, deny, progress, cancel, terminal, stale-fence, recovery, and receipt events. |
| Tests/verification | Changed | Adds admission, repository, executor, cancellation, recovery, DTO-redaction, MCP, and local runtime/job checks. |

Test plan:
- Unit: waiting-status copy contains no `worker` or `capacity`.
- Unit: waiting-status dedupe sends `Still starting this request.` once per
  episode.
- Unit: runtime admission keeps jobs/tasks/maintenance off live chat slots.
- Unit: host capacity detection falls back from `os.availableParallelism()` to
  `os.cpus().length`.
- Unit: Task repository creates, reads, lists, transitions, fences stale writes,
  records receipts, and redacts private correlation in DTOs.
- Unit: `async_run_command` checks command authority before process spawn.
- Unit: denied command work never invokes the process runner.
- Unit: cancellation kills the full process group and ignores late terminal
  writes.
- Unit: `delegate_task` and `task_update` are not mounted in V1.
- Integration: saturated background jobs plus new chat still admits through the
  live path.
- Integration: `task_get` and `task_list` return durable status after restart.
- Integration: crash recovery covers all required windows.
- Integration: cross-agent, cross-conversation, cross-thread, stale-run,
  missing-capability, malformed task-id, and terminal-task mutation cases fail
  closed.
- Postgres: migration and repository tests run against disposable Postgres with
  required extensions.
- Cleanup: raw provider task names and private ids appear only in
  adapter-private exclusions/sentinels/tests or historical docs, never public
  DTOs/renderers.

Required verification and closeout:
1. Run focused checks after each slice.
2. Run automated tester after implementation and before deterministic verify.
3. Record automated test artifact:
   - `python3 .codex/scripts/record_test_from_json.py --kind automated --input /tmp/automated-test.json`
4. Run deterministic verify:
   - `python3 .codex/scripts/verify.py`
5. Run ponytail simplification review and remove overbuilt abstractions, extra
   settings, premature APIs, and compatibility shims.
6. Run autoreview:
   - `.agents/skills/autoreview/scripts/autoreview --mode local`
   - or `.agents/skills/autoreview/scripts/autoreview --mode branch --base origin/main`
7. Move to reviewing only after automated tests are recorded and verify passes:
   - `python3 .codex/scripts/update_run.py --phase reviewing`
8. Build and restart the local launchd runtime from this checkout:
   - `npm run build`
   - `gantry service restart`
   - `gantry status`
   - If `gantry service restart` cannot prove launchd restarted `com.gantry`,
     use launchd directly and record the exact command, such as
     `launchctl kickstart -k "gui/$(id -u)/com.gantry"`, then confirm with
     `gantry status`.
9. Trigger the existing Knacklabs lead generation job through the product path:
   - Find the existing job with `gantry jobs list` or the Control API; do not
     create a duplicate job.
   - Trigger it with `gantry jobs trigger <job_id>`.
   - Use `gantry jobs show <job_id>` and `gantry jobs events <job_id> --full` or
     equivalent runtime evidence until the triggered run reaches a passing
     terminal state with durable receipt/outcome evidence.
10. Create a PR only after local runtime and the Knacklabs job pass:
    - Commit the implementation and docs.
    - Push the branch and open a PR.
    - Watch CI to completion and fix failures until CI is passing.

Final handoff must include:
- Exact behavior implemented.
- Files changed grouped by surface.
- Acceptance criteria status.
- Surface Impact Matrix.
- Cleanup search results and interpretation.
- Automated-tester artifact status.
- Ponytail findings and what was simplified.
- Autoreview findings and disposition.
- Verification commands run and results.
- Local build, launchd restart, and `gantry status` evidence.
- Knacklabs lead generation trigger id, terminal run status, and receipt evidence.
- PR link and CI status.
```
