# Phase 5: Jobs, Runtime, And Activity

## Goal

Expose durable runtime evidence without browser-owned policy or secrets. Reuse
job, run, usage, model, memory, and desired-state services; add only the
paginated activity read model.

## Dependencies And Exclusions

Dependencies: shared tables, timelines, SSE coordinator, job/run/usage/model
services, and desired-state APIs. Excluded: a browser policy engine, raw
scheduler internals, a second event store, and secret display.

## Screens

| Screen    | Major sections and actions                                                                 |
| --------- | ------------------------------------------------------------------------------------------ |
| Jobs/runs | Definitions, status, blockers, notifications, timeline, one clear blocker action.          |
| Runtime   | Models, memory, usage, capacity, queue, sandbox, egress, guardrails, redacted diagnostics. |
| Activity  | Cursor timeline with actor, resource, and event-type filters.                              |

## Steps

1. Compose job/run and runtime routes from server projections; hide raw lease
   and scheduler internals.
2. Add `/v1/activity` cursor contract over existing runtime/audit repositories.
3. Use SSE to invalidate summaries, then fetch detail by ID. Browser code does
   not infer policy, readiness, or secret values.
4. Route settings-owned changes through desired-state revision APIs.

## Acceptance And Checks

- Lifecycle/blockers update live and missing capabilities show one safe action.
- Cursor/filter activity is stable and redacted; queue/sandbox/egress views do
  not expose secrets or become the policy engine.

```bash
npm run test:unit -- apps/core/test/unit/control/usage-routes.test.ts apps/core/test/unit/control/run-event-projection.test.ts apps/core/test/unit/application/job-readiness-service.test.ts
GANTRY_TEST_DATABASE_URL=<disposable-url> npm run test:integration:postgres
npm run test:unit --workspace @gantry/web -- src/features/jobs src/features/runtime src/features/activity
npm run test:e2e --workspace @gantry/web -- tests/e2e/jobs-runtime.spec.ts
rg -n -e 'pg-boss' -e 'pgboss' -e 'yolo_mode' -e 'approve.*tool' -e 'policyEngine' apps/web/src
```

## Surface Impact And Handoff

| Surface                                                                | Status              | Reason                                          |
| ---------------------------------------------------------------------- | ------------------- | ----------------------------------------------- |
| Runtime, settings, Postgres, API, contracts, audit/events, tests, docs | Changed             | Add activity projection and safe runtime UI.    |
| CLI, MCP/admin, providers                                              | Unchanged by design | Existing authority and transport remain intact. |

Phase 6 can link people to activity and Conversations without changing alias
provenance.
