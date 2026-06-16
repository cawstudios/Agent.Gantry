# Durable Lifecycle Authority Plan

Status: future product-slice plan for LOCAL-36. This is not implementation
evidence.

## 1. Problem

Async and long-running delegated work needs durable Gantry authority before any
provider-native task mechanism can be user-visible. Provider task ids and SDK
state are adapter evidence only; they cannot be the durable command surface for
launch, check, update, cancel, list, progress, terminal result, or terminal
failure.

## 2. Scope / Non-goals

In scope:

- Durable lifecycle state keyed by app, agent, conversation, thread, parent run,
  live turn where present, principal, capability scope, idempotency key, lease
  token, and fencing version.
- Gantry-owned lifecycle commands for launch, check, update, cancel, list,
  progress, terminal result, and terminal failure.
- Pending interaction creation before provider or channel prompts render.
- Rejection of stale workers, stale fences, wrong parent run, wrong thread,
  replayed commands, and post-terminal writes.

Non-goals:

- No provider-native task id as public durable authority.
- No raw DeepAgents async task tools.
- No direct Anthropic native `Task` authority.
- No runtime-event-as-command-bus shortcut.

## 3. Acceptance Criteria

- Launch is idempotent for a parent run and lifecycle idempotency key.
- Check/update/cancel/list validate app, agent, principal, conversation, thread,
  parent run, capability scope, lease token, and fencing version.
- Terminal evidence is durable before any external delivery reports success.
- Denied launch never invokes provider delegation APIs.
- HITL prompts create durable `pending_interactions` rows before rendering.
- Recovered or stale workers cannot write progress, terminal output, receipts,
  or provider correlation ids.

## 4. Technical Approach

Add narrow application/domain ports for task lifecycle authority and implement
them in Postgres. Runtime code uses the lifecycle repository for command and
state authority; `runtime_events` remains observable evidence only.

### Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Lifecycle commands become durable and fenced. |
| `settings.yaml` | Unchanged by design | Durable runtime authority is not desired-state configuration. |
| Postgres/runtime projection | Changed | New lifecycle rows/read models are required. |
| Control API | Deferred | Public status/command endpoints belong to the UX/rejoin slice. |
| SDK/contracts | Deferred | Public DTOs belong to the UX/rejoin slice. |
| CLI | Unchanged by design | No local command surface is needed for authority. |
| Gantry MCP tools/admin skill | Deferred | Agent-facing delegation tools require later capability approval. |
| Channel/provider adapters | Changed | Providers receive commands only after Gantry authority permits them. |
| Docs/prompts | Changed | Update architecture and goal prompts when the slice starts. |
| Audit/events | Changed | Attempts, denials, stale writes, and terminal state must be audited. |
| Tests/verification | Changed | Unit, Postgres integration, and stale-write tests are required. |

## 5. Task Decomposition

1. Define lifecycle command/state types and a narrow repository port.
2. Add Postgres schema/repository with unique idempotency and fencing checks.
3. Add lifecycle service enforcing parent run, principal, thread, capability,
   lease token, and terminal-state rules.
4. Wire provider-adapter call sites to request lifecycle authority before
   invoking provider task APIs.
5. Add pending-interaction durability before any HITL prompt projection.

## 6. Risks

- Treating runtime events as commands would bypass replay and fencing.
- Provider task ids could leak into public authority if stored without a Gantry
  id boundary.
- Interaction prompts rendered before durable rows would lose approvals during
  crash or restart.

## 7. Verify Plan

- Focused lifecycle service unit tests.
- Disposable Postgres integration tests for concurrent launch, stale writes,
  wrong-thread rejection, post-terminal rejection, and idempotent retry.
- Permission/HITL tests proving denied launch does not invoke provider APIs.
- `python3 .codex/scripts/check_architecture.py`
