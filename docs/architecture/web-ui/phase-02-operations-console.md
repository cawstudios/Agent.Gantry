# Phase 2: Operations Console

## Goal

Deliver an operator view of canonical runtime state. Reuse provider,
conversation, health, doctor, usage, job, and run services. Add only
session-list, interaction-list/resolve, and event projections missing from the
current API. Provider-native payloads never reach React.

## Dependencies And Exclusions

Dependencies: Phase 1 shell, browser client, SSE coordinator, shared tables,
and inspectors. Excluded: agent editing, WebUI chat, workflow authoring, and
provider transport changes.

## Screens

| Screen        | Major sections and actions                                                    |
| ------------- | ----------------------------------------------------------------------------- |
| Overview      | Health, usage, active work, waiting interactions, recent activity, drill-in.  |
| Providers     | Accounts, readiness, discovery, redacted secret readiness, open Conversation. |
| Conversations | List/filter, message/thread inspector, policy, approvers, agent installs.     |
| Interactions  | Context and server-offered `Allow once`, durable choice, or `Cancel`.         |
| Diagnostics   | Health, doctor findings, guided remediation, provider readiness.              |

List/detail screens use shared tables and inspectors; mobile uses drawers or
routed detail. Every screen implements shared loading through offline states.

## Steps

1. Compose routes with Phase 1 query keys, tables, inspectors, timelines, and
   event invalidation.
2. Add browser-safe interaction list/resolve and session-list routes through
   application services; resolution is the same durable path as channels.
3. Project canonical conversation/interaction updates into SSE. Provider socket
   events only wake server work.
4. Submit secrets only to dedicated write-only server forms; render redacted
   readiness and remediation.

## Acceptance And Checks

- An operator discovers a Conversation, inspects policy/messages, resolves a
  pending interaction, and sees all affected views converge via events.
- Diagnostics are server-derived; secrets and raw provider payloads never enter
  rendered components or query cache.

```bash
npm run test:unit -- apps/core/test/unit/control/ui-events-routes.test.ts apps/core/test/unit/control/pending-interactions-routes.test.ts apps/core/test/unit/application/pending-interaction-durability.test.ts
npm run test:unit --workspace @gantry/web -- src/features/overview src/features/providers src/features/conversations
npm run test:e2e --workspace @gantry/web -- tests/e2e/operations.spec.ts
rg -n -e 'slack_event' -e 'slackPayload' -e 'SocketMode' -e 'xapp-' -e 'providerPayload' -e 'statusColor' apps/web/src
```

## Surface Impact And Handoff

| Surface                                            | Status               | Reason                                                            |
| -------------------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| Runtime, API, contracts, audit/events, tests, docs | Changed              | Add safe projections, routes, event types, and operator guidance. |
| Postgres                                           | Read-only/observable | Reuse durable interactions and runtime events.                    |
| Settings, CLI, MCP/admin, providers                | Unchanged by design  | No config, authority, or transport change.                        |

Phase 3 reuses interaction and Conversation compositions without forking them.
