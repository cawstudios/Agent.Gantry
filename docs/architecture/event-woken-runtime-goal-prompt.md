# Event-Woken Runtime Goal Prompt

Use this prompt to implement Gantry's event-woken runtime cleanup.

```text
/goal Make Gantry event-woken on live hot paths without chasing "pure event driven" as a false absolute.

Use the ponytail skill for implementation discipline: smallest correct diff, deletion over abstraction, no speculative queue/provider layer, no new config unless existing code proves it is unavoidable.

Use the planner and decomposer prompts before coding:
- read .codex/prompts/planner.md
- read .codex/prompts/decomposer.md
- decompose by capability/behavior, not file count

Strong decision:
Gantry must be event-woken with durable replay, not "no polling anywhere".
Events are latency hints. Postgres durable rows, leases, fencing, cursors, and bounded recovery loops remain the source of correctness.

Problem:
The current runtime is already partly event-woken through durable live admission work items and Postgres NOTIFY, but old naming and fallback paths still make the architecture look polling-led. Live-turn command delivery also still depends on owner tick latency.

Scope:
1. Remove the legacy route-wide live message polling path.
2. Add wakeup plumbing for live-turn command inbox drains.
3. Rename misleading runtime/bootstrap variables from polling terminology where they now wrap durable admission.
4. Keep runtime_events observable-only.
5. Document the architecture as event-woken durable replay.
6. Add focused tests for missed wakeups and command delivery.

Non-goals:
- Do not remove lease heartbeats, run-slot renewal, recovery sweeps, settings revision fallback, runtime event cursor replay, outbound delivery recovery, pg-boss internals, or Telegram provider polling.
- Do not add Redis, Kafka, SQS, pgmq, or a generic queue abstraction.
- Do not use runtime_events as a command bus.
- Do not add a settings.yaml event-backend or polling-toggle knob.

Acceptance criteria:
1. Production live admission does not depend on route-wide getNewMessages scans.
2. New inbound live messages are admitted through durable live_admission_work_items.
3. A continuation, /stop, close-stdin, or interaction resolution wakes the owning live-turn worker without waiting for the normal owner tick.
4. If the wakeup is dropped, the existing tick/recovery path still drains pending commands.
5. A stale or fenced owner cannot apply pending commands.
6. runtime_events remains observable output only.
7. Cleanup search shows no active references to the old route-wide live poller.
8. Docs say "event-woken durable replay", not "pure event driven".

Surface Impact Matrix:
- Runtime behavior: Changed. Live hot paths become wakeup-first while safety loops remain.
- settings.yaml: Unchanged by design. No new config knob.
- Postgres/runtime projection: Changed only for command-inbox wakeup plumbing if needed; durable tables remain authority.
- Control API: Unchanged by design. No public API change.
- SDK/contracts: Unchanged by design. Same observable event/cursor contract.
- CLI: Unchanged by design. No operator command change.
- Gantry MCP tools/admin skill: Unchanged by design. No capability/authority change.
- Channel/provider adapters: Read-only/observable. Telegram polling remains provider transport; Slack/Teams remain callback/socket paths.
- Docs/prompts: Changed. Update architecture wording and this goal prompt as contract.
- Audit/events: Read-only/observable. runtime_events remains evidence, not routing authority.
- Tests/verification: Changed. Add focused unit/Postgres tests and cleanup searches.

Task decomposition:
1. Runtime admission cleanup
   - Write scope: live execution bootstrap and legacy message-loop references.
   - Verify: route-wide polling no longer drives production live admission.

2. Live command wakeup
   - Write scope: live-turn command append/drain path and Postgres notifier wiring.
   - Verify: owner drains promptly on wakeup; missed wakeup still recovers.

3. Documentation and naming
   - Write scope: relevant architecture docs and misleading polling variable names.
   - Verify: wording matches event-woken durable replay.

4. Tests and cleanup
   - Write scope: focused runtime/Postgres tests only.
   - Verify: tests fail without the new wakeup/cleanup and pass after.

Required focused checks:
- npm run test:unit -- apps/core/test/unit/runtime
- npm run test:integration:postgres
- rg -n "startMessagePollingLoop|runMessagePollingTick|\\bPOLL_INTERVAL\\b|pollingLoop" apps/core/src apps/core/test docs/architecture --glob '!event-woken-runtime-goal-prompt.md'

Full verification:
- npm run build
- npm test
- python3 .codex/scripts/verify.py
- python3 .codex/scripts/check_task_completion.py

Closeout review:
Run the installed autoreview helper after implementation and focused tests:
- /Users/ravikiranvemula/.codex/skills/autoreview/scripts/autoreview --mode local

If autoreview finds an actionable issue:
- verify the finding in code
- apply the smallest correct fix
- rerun affected tests
- rerun autoreview until clean

Runtime smoke after green tests and clean autoreview:
1. Build from this checkout:
   npm run build
2. Restart local launchd service:
   launchctl kickstart -k gui/$(id -u)/com.gantry
3. Confirm runtime:
   gantry status
4. Find the scheduler job named "Knacklabs lead gen" using scheduler_list_jobs.
5. Queue it with scheduler_run_now using the discovered job id.
6. Inspect completion using scheduler_wait_for_events, scheduler_list_runs, or scheduler_list_events. Do not monitor with Bash sleep loops.

PR closeout:
1. Review git diff for unrelated changes; do not include unrelated user work.
2. Commit only the task changes.
3. Push the branch.
4. Create a PR with:
   - summary
   - tests run
   - autoreview result
   - launchd restart/status result
   - Knacklabs lead gen run result
   - intentional deferrals
```
