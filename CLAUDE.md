# Gantry Agent Instructions

This repository uses `AGENTS.md` as the primary working contract for coding
agents. Read it first, then follow `WORKFLOW.md`, `docs/FACTORY.md`, and
`docs/QUALITY.md` for factory phase execution.

Gantry-owned capability changes must go through reviewed runtime tools rather
than direct local mutation. Agent-facing capability request and interaction
tools are:

- `send_message`
- `ask_user_question`
- `request_skill_install`
- `request_skill_proposal`
- `request_skill_dependency_install`
- `request_mcp_server`
- `request_permission`
- `service_restart`
- `register_agent`

Runtime source of truth remains `settings.yaml` plus application services as
described in `AGENTS.md` and `docs/architecture/capability-management.md`.

## Dev-mode exception (operator-granted, 2026-06-10)

When working as the repo coding agent against the LOCAL dev runtime
(`~/gantry`), directly editing `~/gantry/settings.yaml` and the `~/gantry/.env`
dev/test flags to adjust-and-test is explicitly allowed — restart core to
apply (both are boot-parsed). This grant covers local dev/testing only (see
`docs/BOONDI-E2E-TESTING.md`) and, for that scope, takes precedence over the
no-direct-mutation rule above and the matching `settings.yaml` edit
restrictions in `AGENTS.md`. It does NOT extend to Gantry runtime agents
(they keep using the request tools above), and it is not a license to bypass
a live agent's pending permission/approval flow.
