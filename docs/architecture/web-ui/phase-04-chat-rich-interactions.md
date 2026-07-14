# Phase 4: Chat And Rich Interactions

## Goal

Deliver WebUI chat through canonical sessions and `InteractionDescriptor`.
REST submits commands; SSE observes durable runs. The browser neither filters
reasoning by text heuristics nor defines a parallel rich-message schema.

## Dependencies And Exclusions

Dependencies: Phase 1 pairing/events and Phase 2 interaction APIs. Excluded:
provider WebSockets, browser-held provider credentials, text-based reasoning
filters, and a separate rich descriptor protocol.

## Screens

| Screen        | Major sections and actions                                                              |
| ------------- | --------------------------------------------------------------------------------------- |
| Session list  | Agent/conversation/status filters, title, recent activity, create/open.                 |
| Chat thread   | Messages, stream, connection state, run timeline, final evidence, files.                |
| Composer      | Text, supported attachment, send, stop/cancel.                                          |
| Rich renderer | Questions, approvals, todos, facts, lists, tables, forms, media, dependencies, results. |

## Steps

1. Reuse session ensure/get/messages/events/runs and memory APIs; add only
   session list and interaction resolve gaps named by the parent plan.
2. Present `202 Accepted` as durable admission, never completion.
3. Render all descriptor kinds through shared `ui/rich` components; interaction
   actions use durable server APIs.
4. Throttle paint work without dropping events; refetch after reconnect or an
   unknown event type.

## Acceptance And Checks

- A turn is accepted, streamed, interrupted by a question/permission, resolved
  in UI or channel, resumed, and completed after reconnect.
- Reasoning blocks are omitted at provider boundaries, not by UI prefix filters.

```bash
npm run test:unit -- apps/core/test/unit/channels/rich-interaction.test.ts apps/core/test/unit/runtime/pending-interaction-runtime-event.test.ts apps/core/test/unit/application/sessions/session-interaction-module.test.ts
npm run test:integration -- apps/core/test/integration/session-control-runs.integration.test.ts apps/core/test/integration/permission-approval-ipc.integration.test.ts
npm run test:unit --workspace @gantry/web -- src/features/chat src/ui/rich
npm run test:e2e --workspace @gantry/web -- tests/e2e/chat-reconnect.spec.ts
rg -n -e 'startsWith\(' -e 'includes\(.*thinking' -e 'UISpec' -e 'RichInteractionDescriptor.*interface' -e 'providerPayload' apps/web/src
```

## Surface Impact And Handoff

| Surface                                            | Status               | Reason                                                             |
| -------------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| Runtime, API, contracts, audit/events, tests, docs | Changed              | Add session listing, rich rendering, event handling, and coverage. |
| Postgres                                           | Read-only/observable | Reuse durable sessions, messages, runs, and interactions.          |
| Settings, CLI, MCP/admin, providers                | Unchanged by design  | No configuration, authority, or transport widening.                |

Phase 5 reuses shared timelines but owns jobs and runtime controls separately.
