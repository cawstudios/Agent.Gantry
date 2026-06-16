# Provider Delegation Projection Plan

Status: future product-slice plan for LOCAL-36. This is not implementation
evidence.

## 1. Problem

DeepAgents and Anthropic SDK both expose useful delegation features, but their
raw surfaces can bypass Gantry policy, audit, sandbox, skill/MCP scope, and
user-visible receipts. Gantry needs provider-specific projections behind one
neutral lifecycle authority.

## 2. Scope / Non-goals

In scope:

- DeepAgents synchronous/default subagent projection through Gantry-owned
  lifecycle commands.
- DeepAgents async subagent projection through Gantry-owned launch/check/update/
  cancel/list commands.
- Anthropic SDK native `Agent`/`Task` projection through the same lifecycle
  command model.
- Adapter-private provider task ids, checkpoint thread ids, and subagent
  handles.

Non-goals:

- No raw DeepAgents `task`, `write_todos`, or async task tools as model-visible
  product authority.
- No Anthropic native subagent permission inheritance without Gantry tests.
- No remote Agent Protocol topology without explicit auth, capability, audit,
  worker-pool, and backpressure rules.
- No user-facing subagent dashboard.

## 3. Acceptance Criteria

- Raw DeepAgents task tools remain hidden unless a Gantry wrapper owns the call.
- Gantry returns a durable task id quickly for accepted delegated work.
- Provider task ids remain adapter-private correlation evidence.
- DeepAgents co-deployed topology is the default when Gantry owns both sides.
- Remote topology is unavailable or capability-gated with explicit auth and
  backpressure rules.
- Anthropic native `Agent`/`Task` launches are denied by default or wrapped
  behind Gantry lifecycle authority.
- Parent and delegated scopes are deterministic for model, tool, MCP, skill,
  permission, sandbox, and receipt behavior.

## 4. Technical Approach

Keep provider-specific parsing and invocation in adapters. The adapter receives
a Gantry lifecycle command, invokes provider delegation only after policy allows
it, and emits sanitized lifecycle events through the neutral wrapper.

### Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Delegation starts through Gantry lifecycle commands. |
| `settings.yaml` | Deferred | Delegation defaults need a separate desired-state decision. |
| Postgres/runtime projection | Changed | Provider correlation maps to durable lifecycle rows. |
| Control API | Deferred | Status projection is owned by the UX/rejoin slice. |
| SDK/contracts | Changed | Adapter-facing lifecycle command/result contracts change. |
| CLI | Unchanged by design | No local command surface is needed for provider projection. |
| Gantry MCP tools/admin skill | Deferred | Agent-facing delegation tools require capability approval. |
| Channel/provider adapters | Changed | Anthropic and DeepAgents adapters implement wrapped projection. |
| Docs/prompts | Changed | Provider docs and prompts must describe wrapped authority. |
| Audit/events | Changed | Delegation attempts, denials, and provider correlation are audited. |
| Tests/verification | Changed | Raw denial, wrapper, and provider boundary tests are required. |

## 5. Task Decomposition

1. Add a DeepAgents delegation wrapper that maps Gantry lifecycle commands to
   selected DeepAgents sync/default/async mechanisms.
2. Keep raw DeepAgents task tools hidden in model-visible tool projection.
3. Add Anthropic native `Agent`/`Task` wrapper or default-denial path.
4. Add permission-order tests for Anthropic hooks, `allowedTools`, and broad
   permission-mode inheritance.
5. Add provider correlation redaction and lifecycle-event mapping tests.

## 6. Risks

- Provider defaults may inherit broader tools or permissions than Gantry
  selected for the parent run.
- Async task state can outlive the parent run unless fenced.
- Remote agent topology can become a second control plane without explicit
  auth, audit, and backpressure.

## 7. Verify Plan

- DeepAgents raw authority denial tests.
- DeepAgents wrapper unit and boundary integration tests.
- Anthropic SDK boundary integration tests.
- Cleanup searches for raw task tool names and native task entrypoints.
- `npm run build`
