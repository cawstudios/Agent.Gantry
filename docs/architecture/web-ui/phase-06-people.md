# Phase 6: People

## Goal

Expose canonical people and provider aliases for operators. A person is not a
browser account; identity and SSO remain deferred. Provider IDs stay aliases
with provenance and cannot become interchangeable UI identities.

## Dependencies And Exclusions

Dependencies: Conversation views and shared forms/tables. Excluded: browser
accounts, SSO, email-as-proof linking, client-only people records, and changes
to provider identity semantics.

## Screens

| Screen        | Major sections and actions                                                 |
| ------------- | -------------------------------------------------------------------------- |
| People list   | Search, aliases, relevant Conversations, invitation status, open detail.   |
| Person detail | Canonical identity, alias provenance, related activity, invitation, merge. |
| Merge preview | Source/target, affected aliases/Conversations, conflicts, confirm/cancel.  |
| Merge receipt | Atomic outcome, preserved provenance, audit reference, refreshed records.  |

## Steps

1. Add people application service and browser-safe `/v1/users` contracts over
   existing user and alias storage.
2. Add server-side merge preview and atomic merge command with explicit unsafe
   conflict rejection plus durable audit/provenance.
3. Compose routes with shared tables, inspectors, dialogs, and SSE invalidation;
   do not create a client-only people store.

## Acceptance And Checks

- A safe merge is atomic and preserves aliases, provenance, audit evidence, and
  Conversation references; unsafe conflicts reject before mutation.
- Affected UI state refreshes without reload and never conflates an external
  provider ID with the canonical person ID.

```bash
npm run test:unit -- apps/core/test/unit/application/user-administration-service.test.ts apps/core/test/unit/control/users-routes.test.ts
GANTRY_TEST_DATABASE_URL=<disposable-url> npm run test:integration:postgres
npm run test:unit --workspace @gantry/web -- src/features/people
npm run test:e2e --workspace @gantry/web -- tests/e2e/people-merge.spec.ts
rg -n -e 'slackUserId' -e 'teamsUserId' -e 'telegramUserId' -e 'discordUserId' -e 'peopleStore' apps/web/src apps/core/src/application
```

## Surface Impact And Handoff

| Surface                                             | Status               | Reason                                                       |
| --------------------------------------------------- | -------------------- | ------------------------------------------------------------ |
| Postgres, API, contracts, audit/events, tests, docs | Changed              | Add people read/merge services, audit, and coverage.         |
| Runtime                                             | Read-only/observable | Conversations and messages observe canonical people changes. |
| Settings, CLI, MCP/admin, providers                 | Unchanged by design  | No auth, desired-state, authority, or transport change.      |

Phase 7 may attribute workflow activity to people but cannot use people as a
new permission authority.
