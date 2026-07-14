# Phase 3: Agent Administration

## Goal

Manage agent desired state through Gantry services. Browser code never edits
profile files, `settings.yaml`, or Postgres directly; raw provider model IDs
remain invalid at public UI boundaries.

## Dependencies And Exclusions

Dependencies: Phase 2 Conversation and interaction compositions plus existing
desired-state services. Excluded: direct settings/file/SQL writes, raw model
IDs, user identity, and UI-created permission authority.

## Screens

| Screen            | Major sections and actions                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Agent list        | Status, model alias, harness, assigned Conversations, pause, create/select.                           |
| Agent detail      | Identity, model/harness, profile, sources, capabilities, skills, MCP, access, installs, pause/resume. |
| Revision conflict | Server revision, changed fields, reload, deliberate retry after reconciliation.                       |
| Credentials       | Write-only secret input when supported, redacted readiness, one remediation.                          |

## Steps

1. Build agent routes from existing agent, catalog, profile, source,
   capability, skill, MCP, access, and Conversation-install services.
2. Send desired-state writes with `expectedRevision`; display returned revision
   and refetch after SSE.
3. Use protected profile services, catalog aliases, and `agentHarness`, never
   raw provider IDs or legacy engine fields.
4. Render reviewed capability/access state rather than creating a UI permission
   store.

## Acceptance And Checks

- Valid changes survive restart, reconcile projection, and synchronize
  `settings.yaml`; stale writes conflict rather than overwrite.
- No UI route writes files, SQL, or provider-specific flags.

```bash
npm run test:unit -- apps/core/test/unit/control/settings-desired-state-routes.test.ts apps/core/test/unit/config/settings-desired-state-service.test.ts apps/core/test/unit/application/agent-capability-administration-service.test.ts apps/core/test/unit/application/permission-management-service.test.ts
npm run test:unit --workspace @gantry/web -- src/features/agents
npm run test:e2e --workspace @gantry/web -- tests/e2e/agent-admin.spec.ts
rg -n -e 'writeFile' -e 'settings\.yaml' -e 'INSERT INTO' -e 'modelId' -e 'providerModelId' -e 'permissionStore' apps/web/src apps/core/src/control
```

## Surface Impact And Handoff

| Surface                                                                    | Status               | Reason                                                  |
| -------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| Settings, runtime, Postgres projection, API, contracts, audit, tests, docs | Changed              | Add revision-aware administration and safe projections. |
| CLI                                                                        | Read-only/observable | CLI remains another adapter over the same services.     |
| MCP/admin, providers                                                       | Unchanged by design  | No change to agent-request or transport authority.      |

Phase 4 may use agent/conversation selectors but cannot create a second
session or capability model.
