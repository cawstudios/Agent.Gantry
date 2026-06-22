# Async Subagents Gap Closure Goal Prompt

Use this prompt to implement provider-neutral async subagent parity in Gantry
without exposing raw Anthropic or DeepAgents task authority.

```text
/goal Implement Gantry-owned async subagent parity across Anthropic SDK and DeepAgents.

Product contract:
Gantry agents can start delegated async work, inspect status, steer it, cancel
it, inspect async Bash progress while it is still running, recover it after
restart, and receive one durable receipt, using Gantry task ids and Gantry
permission/sandbox policy only.

Current repo truth:
- `todo_update` is the baseline visible planning tool.
- `async_run_command`, `task_get`, `task_list`, and `task_cancel` are mounted
  only when async task tools are enabled.
- `delegate_task` and `task_message` are mounted only when async task tools are
  enabled and `AgentDelegation` is selected.
- `agent_async_tasks` is the durable task store for `async_command` and
  `delegated_agent`.
- Async Bash status includes task-state, heartbeat/elapsed metadata, and
  bounded redacted mid-run stdout/stderr tails through `task_get`.
- Anthropic native `Agent`/`Task` calls must be forced to background mode and
  normalized into Gantry runtime events.
- DeepAgents raw `task`, `write_todos`, filesystem tools, and async tools
  (`start_async_task`, `check_async_task`, `update_async_task`,
  `cancel_async_task`, `list_async_tasks`) must stay hidden unless a
  Gantry-owned wrapper maps them into durable task lifecycle.

External docs to verify before implementation:
- Anthropic Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Anthropic TypeScript Agent SDK: https://code.claude.com/docs/en/agent-sdk/typescript
- DeepAgents async subagents: https://docs.langchain.com/oss/javascript/deepagents/async-subagents
- DeepAgents frontend/task stream model: https://docs.langchain.com/oss/javascript/deepagents/frontend/overview

Locked scope:
- Reuse `agent_async_tasks`; do not create a parallel task model.
- Keep public tool names provider-neutral: `delegate_task`, `task_message`,
  `task_get`, `task_list`, `task_cancel`, `todo_update`.
- Do not expose raw Anthropic `Agent`/`Task`, DeepAgents `task`,
  `write_todos`, or DeepAgents async tool names as durable authority.
- Do not add `task_update`.
- Do not add dashboard or mission-control UI.
- Do not add new `settings.yaml` keys unless implementation proves existing
  gates cannot express the feature.
- Do not use `.claude/agents/`, DeepAgents subagent specs, provider task ids,
  LangGraph thread ids, child pids, lease tokens, or fencing versions as
  public/user-facing identifiers.
- Do not let async Bash status inspection become arbitrary host log access.
  Mid-run output must come from bounded Gantry-owned capture, not from agent
  chosen file paths.

Implementation requirements:
1. Keep DeepAgents raw async subagent API fail-closed until
   `async-subagent-sentinel` proves package/schema compatibility and a
   Gantry-owned Agent Protocol transport is available.
2. Add the smallest Gantry-owned DeepAgents bridge that maps async subagent
   lifecycle into `agent_async_tasks`, returning only a Gantry task id.
3. Preserve Anthropic SDK normalization: native `Agent`/`Task` attempts route
   through `AgentDelegation`, run in background, and emit sanitized task
   lifecycle runtime events.
4. Ensure `task_get`, `task_list`, `task_message`, and `task_cancel` work from
   Gantry task ids after compaction and after host restart.
5. Add mid-run async Bash inspection: while an `async_command` is `running`,
   `task_get` returns current status, last heartbeat/update time, elapsed time,
   and bounded redacted stdout/stderr tails captured by Gantry. This must not
   expose raw protected paths, arbitrary log files, process internals, or
   unbounded output.
6. Add subagent fan-out/backpressure accounting so delegated child work cannot
   silently exceed runtime capacity.
7. Host-enforce delegated task terminal receipts:
   - `Completed: <short outcome>`
   - `Used: <tools/capabilities or none>`
   - `Changed: <files/accounts/channels or none>`
   - `Delegated: yes/no`
   - `Subtasks: <n completed, n failed, n cancelled>` when delegated
   - `Needs attention: <blocker or none>`

Exact UX copy:
- Start accepted: `Started: <short task summary>`
- Status loaded: `Task loaded.`
- Running async command status: `Task is running.`
- List loaded: `Listed <n> async task(s).`
- Steering accepted: `Message sent to delegated task.`
- Cancel success: `Task was cancelled. Nothing else changed.`
- Missing delegation authority: `delegate_task requires AgentDelegation access.`
- Terminal steering: `Task is already finished and cannot receive messages.`
- Provider-private detail requested: `Provider task details are internal. Use the Gantry task id to check status or cancel.`
- DeepAgents unavailable: `Async delegation is unavailable for this DeepAgents version. Gantry did not start delegated work.`

Acceptance criteria:
1. DeepAgents async delegation starts only when package API, Gantry transport,
   async task tools, sandbox policy, and `AgentDelegation` authority are all
   valid.
2. Denied DeepAgents delegation never invokes raw DeepAgents `task` or async
   middleware.
3. Public DTOs never expose raw provider task ids, LangGraph thread ids, pids,
   lease tokens, fencing versions, output files, or provider session ids.
4. Anthropic and DeepAgents lanes produce the same public task states and
   receipt shape.
5. Delegated task steering is persisted before delivery and marked consumed only
   after delivery.
6. `task_get` on a running async Bash task returns status plus bounded redacted
   stdout/stderr tails without granting arbitrary file or host log reads.
7. Restart recovery preserves `task_get`/`task_cancel` semantics or fails closed
   with durable evidence.
8. Subagent fan-out capacity is enforced before child spawn.
9. Cleanup searches prove no raw provider async task names entered public API,
   CLI, settings, MCP/admin docs, or durable config.

Required tests:
- Extend `apps/core/test/unit/adapters/deepagents-async-subagent-sentinel.test.ts`.
- Add DeepAgents wrapper tests for allowed and denied `AgentDelegation`.
- Extend task lifecycle tests for restart/recovery, steering, cancellation, and
  receipt shape.
- Add async Bash mid-run inspection tests proving running `task_get` returns
  status, heartbeat/elapsed data, and bounded redacted output tails.
- Add run-slot/backpressure tests for delegated child fan-out.
- Keep existing Anthropic native `Agent`/`Task` boundary tests green.

Verification:
- `npm run test:unit -- apps/core/test/unit/adapters/deepagents-async-subagent-sentinel.test.ts apps/core/test/unit/jobs/ipc-agent-task-lifecycle-handlers.test.ts apps/core/test/unit/jobs/async-command-task-service.test.ts`
- `npm run test:integration -- apps/core/test/integration/deepagents-langchain-boundary.integration.test.ts apps/core/test/integration/claude-agent-sdk-boundary.integration.test.ts`
- `npm run typecheck`
- `npm run build`
- `python3 .codex/scripts/verify.py`
- `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`
- `python3 .codex/scripts/check_task_completion.py`

Closeout reviews:
- Run local autoreview after implementation and focused tests. Use
  `/Users/ravikiranvemula/.codex/skills/autoreview/scripts/autoreview --mode local`
  while the implementation is still dirty; use `--mode branch --base origin/main`
  after committing or when reviewing a branch diff.
- Run ponytail review on the final diff and remove any complexity findings that
  do not weaken safety, validation, or the requested feature.
- Rerun focused tests and autoreview if either review causes code changes.

Runtime smoke after green tests/reviews:
1. Build from this checkout: `npm run build`.
2. Restart the local runtime from the fresh build:
   `launchctl kickstart -k gui/$(id -u)/com.gantry`.
3. Confirm the running service: `gantry status`.
4. Find the scheduler job named `Knacklabs lead gen` with `scheduler_list_jobs`.
5. Queue it with `scheduler_run_now` using the discovered job id.
6. Inspect completion with `scheduler_list_runs`, `scheduler_list_events`, or
   `scheduler_wait_for_events`; do not use sleep/poll loops or Bash-only job
   monitoring.
```
