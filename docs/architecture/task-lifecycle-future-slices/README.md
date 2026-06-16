# Task Lifecycle Future Slices

Status: future planning index for LOCAL-36. These files are not implementation
evidence and do not approve raw provider task authority.

The immediate approved planning target remains
`docs/architecture/neutral-task-lifecycle-wrapper-plan.md`. The files in this
directory preserve the larger product slices that must land before Gantry can
expose Anthropic SDK native `Agent`/`Task`, DeepAgents synchronous/default
subagents, or DeepAgents async subagents as product capabilities.

Do not expose raw DeepAgents `task`, `write_todos`, `start_async_task`,
`check_async_task`, `update_async_task`, `cancel_async_task`, `list_async_tasks`,
or Anthropic native task authority before these plans are decomposed,
implemented, and verified through Gantry-owned policy, fencing, sandbox, audit,
and user-visible receipts.

Plan files:

- `01-durable-lifecycle-authority-plan.md`: durable state, commands, fencing,
  and permission/HITL gates.
- `02-provider-delegation-projection-plan.md`: DeepAgents and Anthropic native
  delegation wrapped behind Gantry lifecycle authority.
- `03-live-ux-rejoin-receipts-plan.md`: progress, queued input, rejoin,
  structured outputs, and final evidence receipts.
- `04-extension-scope-and-sandbox-plan.md`: skill, MCP, tool, backend, sandbox,
  and egress boundaries for delegated work.
- `05-robustness-telemetry-closeout-plan.md`: retries, timeouts, telemetry,
  protocol adapters, cleanup searches, benchmark evidence, and closeout gates.
