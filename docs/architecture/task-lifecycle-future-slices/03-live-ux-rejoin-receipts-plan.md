# Live UX, Rejoin, and Receipts Plan

Status: future product-slice plan for LOCAL-36. This is not implementation
evidence.

## 1. Problem

First-visible latency matters, but removing agent features is not the product
answer. Users need quick acknowledgement, durable progress, rejoin, queued input,
and clear terminal evidence while richer delegated work continues.

## 2. Scope / Non-goals

In scope:

- Channel-neutral progress states for launch, progress, approval waiting,
  retrying, cancellation, timeout, failure, and completion.
- Durable rejoin cursors and queued input for active delegated work.
- Structured task result validation separate from free-form assistant text.
- Host-enforced final receipt lines.

Non-goals:

- No public subagent mission-control UI.
- No raw provider stream metadata in user-facing messages.
- No first-visible success metric based only on status frames; content-bearing
  assistant output remains the first-visible definition.

## 3. Acceptance Criteria

- Users see that delegated work is running and can rejoin by durable cursor.
- Continuation input is queued and ordered without prompt replay or truncation.
- Final answers that used delegation include exact receipt lines:
  - `Completed: <short outcome>`
  - `Used: <tools/capabilities>`
  - `Changed: <files/accounts/channels or none>`
  - `Delegated: yes/no`
  - `Needs attention: <blocker or none>`
- Structured outputs are schema-validated and redacted before storage/logging.
- Channel adapters render from channel-neutral descriptors.

## 4. Technical Approach

Project lifecycle state into a small channel-neutral descriptor model. Control
API and channel adapters read from durable cursors and descriptors; they do not
derive authority from provider streams.

### Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Progress, queued input, and rejoin become durable UX behavior. |
| `settings.yaml` | Deferred | Low-latency UX profile settings need separate approval. |
| Postgres/runtime projection | Changed | Cursors, queued input, and receipt/read models are required. |
| Control API | Changed | Status, rejoin, and receipt surfaces are exposed. |
| SDK/contracts | Changed | Public status/result DTOs are required. |
| CLI | Deferred | Optional diagnostics need a separate CLI decision. |
| Gantry MCP tools/admin skill | Deferred | Agent-facing lifecycle status tools need capability approval. |
| Channel/provider adapters | Changed | Channels render descriptors; providers remain adapter-private. |
| Docs/prompts | Changed | UX copy and receipt contracts must be documented. |
| Audit/events | Changed | User-visible progress and terminal evidence are auditable. |
| Tests/verification | Changed | Descriptor, projection, rejoin, and receipt tests are required. |

## 5. Task Decomposition

1. Define channel-neutral lifecycle descriptors and receipt builders.
2. Add read models/cursors for delegated task progress and rejoin.
3. Add queued input handling for active delegated work.
4. Add structured-output validation and redaction boundaries.
5. Add channel adapter tests for progress and terminal receipt rendering.

## 6. Risks

- Status messages can be mistaken for first visible assistant output.
- Raw provider stream labels can leak hidden subagent or tool names.
- Receipts generated only by the model can be omitted or fabricated.

## 7. Verify Plan

- Descriptor and receipt unit tests.
- Control/session projection tests.
- Stream/rejoin tests.
- Channel rendering tests.
- Benchmark evidence that first-visible and progress timings are recorded
  separately.
