# Phase 8: Hardening And Release

## Goal

Harden every delivered route for responsive use, accessibility, reconnect,
performance, browser security, and packaging. This phase adds no product-domain
screen; it removes prototype/mocks and closes release evidence.

## Dependencies And Exclusions

Dependencies: every prior phase and its stable contracts. Excluded: new product
features, identity/SSO implementation, and speculative performance machinery.

## Screens

No new product screen is introduced. The phase verifies all shipped screens,
dialogs, drawers, table detail views, pairing, and route states at the defined
desktop and mobile breakpoints.

## Steps

1. Verify 1440px, 1024px, and 390px in light/dark themes: no overlap,
   overflow, inaccessible action, or unstable control dimension.
2. Complete keyboard flow, focus restoration, semantic labels, contrast,
   screen-reader output, and reduced-motion behavior.
3. Force SSE loss/reconnect and prove cursor replay/query invalidation without
   command duplication. Measure before adding virtualization or caches.
4. Audit storage, responses, logs, and errors for credentials, bearer keys,
   session secrets, and raw provider payloads.
5. Package `/ui`, validate direct refresh, document operation, and remove
   prototype code, mocks, stale routes, and unowned deferred flags.

## Acceptance And Checks

- All target viewports/themes pass functional and visual E2E with no overflow
  or overlap; axe and keyboard checks pass.
- Reconnect converges safely; browser storage and safe responses contain no
  secret; production packaging serves `/ui` correctly.

```bash
npm run test:unit --workspace @gantry/web
npm run test:a11y --workspace @gantry/web
npm run test:e2e --workspace @gantry/web
npm run build
npm test
python3 .codex/scripts/verify.py
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
rg -n -e 'TODO' -e 'FIXME' -e 'mock' -e 'prototype' -e 'legacy' -e 'compat' -e 'featureFlag' apps/web apps/core/src/control packages/contracts/src
```

Every cleanup match needs removal or an explicit owner, reason, and removal
condition.

## Surface Impact And Handoff

| Surface                                            | Status               | Reason                                                             |
| -------------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| Runtime, API, contracts, audit/events, tests, docs | Changed              | Complete packaging, coverage, security, and performance hardening. |
| Postgres                                           | Read-only/observable | Exercise durable data using disposable test databases.             |
| Settings, CLI, MCP/admin, providers                | Unchanged by design  | Harden existing behavior without new authority or transport.       |

Release requires the full gates above and a documented decision for any
remaining deferred identity/SSO capability.
