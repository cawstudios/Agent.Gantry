# Ponytail Fresh Audit — 2026-07-19

## Outcome

This is a fresh reduction pass over the post-Phase-2, post-permission-storage
tree. It revalidates the remaining July 16 findings rather than re-deriving
them. The severity floor is clear wins only.

- Remaining original items checked: 22 (18 findings and AR2-AR5).
- Valid: 21 (17 findings and all four architecture slices).
- Stale: 0.
- Absorbed: 1 (F15).
- New clear-win reductions: 9, conservatively about 131-141 lines.
- Dependencies removable: 0.

Pattern-family numbers below refer to the `goals-index.md` preamble: (1) the
same fact stored twice with different lifecycles, (2) mutation before
authorization / delivery versus commit confusion, (3) consolidation fidelity
loss, (4) generated defaults blind to deployment reality, and (5) type-system
lies.

## Remaining-findings validity

| Phase | Item | Verdict      | Current one-line evidence                                                                                                                                                                                                                                                                                                                                       |
| ----- | ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3     | AR2  | **VALID**    | The legacy `ConversationRoute` still owns `folder`, free-form `trigger`, and `added_at` (`apps/core/src/domain/types.ts:72-80`); manual live projection and `registerGroup` writers remain (`apps/core/src/control/server/routes/provider-conversation-live-routes.ts:27`, `apps/core/src/jobs/ipc-admin-handlers.ts:173`).                                     |
| 3     | F5   | **VALID**    | Bare/partially qualified route compatibility is still implemented by `registerGroup` and the selection/recovery helpers in `apps/core/src/app/bootstrap/runtime-app.ts:434-459` and `apps/core/src/application/provider-conversations/thread-queue-key.ts:118-220`.                                                                                             |
| 3     | F9   | **VALID**    | Job notification resolution still accepts camel aliases and reconstructs routes from execution context (`apps/core/src/jobs/job-notification-routes.ts:21-39`); Postgres reconstruction still falls back to top-level `thread_id`, `workspace_key`, and `session_id` (`apps/core/src/adapters/storage/postgres/services/canonical-job-ops-service.ts:722-762`). |
| 3     | F14  | **VALID**    | The route query still selects `external_ref_json`, parses it, and uses it when the binding-id suffix is empty (`apps/core/src/adapters/storage/postgres/repositories/canonical-binding-repository.postgres.ts:129-145,169-178`).                                                                                                                                |
| 4     | AR3  | **VALID**    | Control OpenAPI remains handwritten while the SDK generator exists only as a package script; no `.github` workflow invokes `check:generated` (`apps/core/src/control/server/openapi-schemas.ts`, `packages/sdk/package.json:47`).                                                                                                                               |
| 4     | F4   | **VALID**    | Handwritten job model/default/preview types remain in `packages/sdk/src/job-model-types.ts:442-473` beside generated model schemas at `packages/sdk/src/generated/openapi.ts:2143-2221`.                                                                                                                                                                        |
| 4     | F17  | **VALID**    | `AgentProfileFile*` wire types remain handwritten at `packages/sdk/src/agents.ts:35-55` and duplicated by generated schemas at `packages/sdk/src/generated/openapi.ts:2018-2045`.                                                                                                                                                                               |
| 5     | AR4  | **VALID**    | The provider CLI still constructs settings/storage dependencies and mutates desired settings directly (`apps/core/src/cli/provider.ts:1-30,292-429`); the canonical conversation approver command still delegates back into the provider command (`apps/core/src/cli/provider.ts:257-264`).                                                                     |
| 5     | AR5  | **VALID**    | Generic messaging/runtime still owns provider formatting (`apps/core/src/messaging/text-styles.ts`, `apps/core/src/messaging/router.ts:272-285`, `apps/core/src/runtime/group-output-buffer.ts:62`) while the provider registry still carries a `formatting` field (`apps/core/src/channels/provider-registry.ts:37`).                                          |
| 5     | F13  | **VALID**    | Undocumented provider `info`, `control-allowlist`, and `approvers` branches remain (`apps/core/src/cli/provider.ts:135-211`), and `conversation approvers` still calls `runProviderCommand` (`apps/core/src/cli/provider.ts:257-264`).                                                                                                                          |
| 5     | F20  | **VALID**    | Slack still accepts `LEGACY_CANONICAL_SLACK_THREAD_PREFIX = 'thread:slack:'`, protected by a focused compatibility assertion and stale integration literals (`apps/core/src/channels/slack/thread-ts.ts:3-17`, `apps/core/test/unit/channels/slack-thread-ts.test.ts:17`).                                                                                      |
| 6     | F2   | **VALID**    | `.codex/scripts/migrate_archived_filesystem_memory.mjs` is still 418 lines and tracked-file search finds no caller outside the prior audit documents.                                                                                                                                                                                                           |
| 6     | F8   | **VALID**    | `.codex/scripts/record_test_result.py` is still 51 lines and no prompt, workflow, test, or source file names it; current factory surfaces use `record_test_from_json.py`.                                                                                                                                                                                       |
| 6     | F10  | **VALID**    | `.codex/scripts/run_postgres_integration_with_url.mjs` is still 32 lines; its only non-audit name match is its own usage string.                                                                                                                                                                                                                                |
| 6     | F11  | **VALID**    | `_memorySubjectFromRow` remains declared at `apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts:260` with zero text or structural call sites.                                                                                                                                                                                 |
| 6     | F12  | **VALID**    | `.codex/scripts/sync_github.py` is still a 26-line `gh` wrapper with no tracked caller outside the prior audit documents.                                                                                                                                                                                                                                       |
| 6     | F15  | **ABSORBED** | The 16 dynamic `defaultConnection` assignments are gone; only intentional reject/history coverage remains (`apps/core/test/unit/config/runtime-settings.test.ts:91`, migration files, and the migration-journal test).                                                                                                                                          |
| 6     | F18  | **VALID**    | Injected-`runAgent` fallbacks remain in normal and dead-letter provider resolution (`apps/core/src/jobs/execution.ts:176-181`, `apps/core/src/jobs/execution-dead-letter.ts:81-88`, `apps/core/src/runtime/execution-provider-id.ts:15-29`).                                                                                                                    |
| 6     | F19  | **VALID**    | Review recorders still accept `--blocking`/`--warning`, read old JSON keys, and emit `blocking`/`warnings`; the gate still has a fallback after requiring canonical fields (`.codex/scripts/record_review.py:13-35`, `.codex/scripts/record_review_from_json.py:37-51`, `.codex/scripts/factory_gates.py:193`).                                                 |
| 6     | F21  | **VALID**    | `./contract-primitives` and unused `./primitives` still map to the same artifact (`packages/contracts/package.json:51-55,81-85`) with no repository import of `@gantry/contracts/primitives`.                                                                                                                                                                   |
| 6     | F22  | **VALID**    | `.codex/scripts/post_tool_use.py` remains a three-line no-op while the hook contract explicitly asserts that it is not configured (`.codex/scripts/tests/test_hook_contracts.py:223`).                                                                                                                                                                          |
| 6     | F24  | **VALID**    | `MemoryScope` and `MemorySearchResult` are still re-exported only by `apps/core/src/domain/repositories/domain-types.ts:10-13`; no consumer imports them through that barrel, and the matching exception remains at `.codex/architecture-exceptions.json:507-513`.                                                                                              |

## New clear-win reductions

Ranked by conservative line reduction, then risk.

| Rank | Tag      | Clear win                                                                            |             Lines saved | Risk       | Pattern family | Evidence / replacement                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | -------- | ------------------------------------------------------------------------------------ | ----------------------: | ---------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1   | `delete` | Delete the dead duplicate provider-secret default map.                               |                     ~30 | Low        | 1              | `defaultRuntimeSecretRefs()` and its import have zero call sites (`apps/core/src/application/settings/desired-state-provider-conversations.ts:6,96-122`), while the live map is `DEFAULT_RUNTIME_SECRET_REFS` in `runtime-settings.ts:69-87`. Replacement: nothing.                                                                                                                                                                             |
| N2   | `shrink` | Stop decoding question selections twice.                                             |                  ~22-26 | Low        | 1              | `persistQuestionProgress()` first validates `questionRecoveryEnvelope`, but its callback re-reads the raw payload through the single-use 29-line `questionSelectionsFromPayload()` (`apps/core/src/application/interactions/pending-interaction-durability.ts:222-233,338-360`; `pending-interaction-question-selections.ts:1-28`). Build the `Map` directly from the already-validated `envelope.selections`.                                  |
| N3   | `shrink` | Use one durable-question callback reader for Slack and Teams.                        |                  ~20-22 | Low        | 1              | `readDurableQuestionCallback()` and `readTeamsUserQuestionCallback()` are line-for-line shape validators (`apps/core/src/channels/slack/channel-user-question-utils.ts:57-78`; `apps/core/src/channels/teams-user-question.ts:47-68`). Put the reader beside `DurableQuestionCallback` and reuse it.                                                                                                                                            |
| N4   | `yagni`  | Remove the test-only `listPendingInteractions` production port method.               | ~20-25 production lines | Low-medium | 5              | There are zero production calls; only tests call it. The application mentions it only to spell a `PendingInteraction` type (`apps/core/src/application/interactions/pending-interaction-durability.ts:338-342`). Delete the port and Postgres method (`worker-coordination.ts:406-410`; `worker-coordination-interaction-repository.postgres.ts:233-253`), use `PendingInteraction` directly, and keep invariant inspection in test-owned code. |
| N5   | `delete` | Delete the superseded `activeCapabilities()` mapper pair.                            |                     ~15 | Low        | 1              | `activeCapabilities()` and private `capabilityFromToolBinding()` have zero call sites (`apps/core/src/config/settings/desired-state-export-helpers.ts:25-31,95-102`); the live export path uses `readableActiveCapabilities()`.                                                                                                                                                                                                                 |
| N6   | `delete` | Delete unused `loadToolsById()`.                                                     |                     ~14 | Low        | 5              | The exported helper has zero text and structural call sites (`apps/core/src/application/settings/desired-state-service-helpers.ts:291-303`); `loadMcpServersById()` is the only live sibling.                                                                                                                                                                                                                                                   |
| N7   | `shrink` | Remove the ignored `readableActiveCapabilities` options parameter and caller object. |                    ~6-7 | Low        | 5              | The signature accepts `_options` but never reads it (`apps/core/src/config/settings/desired-state-export-helpers.ts:70-77`), while the sole caller constructs skill maps for it (`apps/core/src/application/settings/desired-state-current-export.ts:155-164`).                                                                                                                                                                                 |
| N8   | `delete` | Collapse permission/question re-export ladders.                                      |                      ~5 | Low        | 5              | `pending-interaction-prompt-binding.ts:19-22` re-exports envelope/question readers and types; `pending-interaction-durability.ts:159-175` re-exports them again. Import/re-export from the owning files directly and remove the unused `DurablePermissionFullView` facade export.                                                                                                                                                               |
| N9   | `delete` | Remove the post-AR1 config-index shim for `SettingsDesiredStateService`.             |                      ~1 | Low        | 5              | `apps/core/src/config/index.ts:35` re-exports the application service solely for `apps/core/src/cli/settings.ts:9-15`; every other consumer imports the application owner directly. Change that one import and delete the reverse-layer shim.                                                                                                                                                                                                   |

### Swept and declined

- **Status-blind `installedAgents` traversal:** declined as an action item.
  Runtime/model/control/admission/allowlist consumers filter active installs;
  renderer, exporter, and pruning paths intentionally retain disabled installs.
- **Four provider permission-settlement flows:** declined. The recovery decision
  is now application-owned; remaining provider code is transport-specific
  terminalization/feedback rather than four copies of authority logic.
- **Duplicate external-user-id normalization/regexes:** declined for this
  round. The copies are real, but moving them to a new owner has uncertain or
  negligible net deletion and risks family-3 fidelity churn.
- **Broad `pending-interaction-durability.ts` facade deletion:** declined. It is
  a heavily consumed application boundary; only the provably redundant
  re-export ladder in N8 is a clear win.

## Transitional remnants from Phase 2 and the permission cycle

1. **Migration ledger - resolved:** the execution ledger now names migration head
   0104_settings_authority_cutover and records the matching journal index,
   timestamp, counts, and hashes.
2. **Architecture-map owner - resolved:** the map now budgets the
   application-owned desired-state service at 830 lines; the current file is
   823 lines.
3. **AR1 layer cycle - resolved:** the architecture checker now reports zero
   application-to-config or config-to-application settings imports, with no
   exception added or widened.
4. **Active-doc paths - resolved:** references now point at the application
   settings owners, shared runtime-settings contracts, migration 0103 snapshot,
   and the full Postgres schema path.
5. **Transient trigger bridge:** public/YAML parsing and rendering correctly
   reject/omit install-level trigger, but `RuntimeConfiguredConversationInstall`
   still has `trigger?`; in-memory writers set it and routing reads it
   (`apps/core/src/shared/runtime-settings.ts:51-61`, `apps/core/src/config/settings/runtime-settings.ts:414-422`,
   `conversation-install-settings.ts:39-49`,
   `desired-state-service-helpers.ts:96-103`). This is expected AR2/F5 residue,
   not a separate new finding: delete it when trigger derivation moves to the
   canonical live-route projection.
6. **Dead settings helpers/options - resolved:** N1, N5, N6, and N7 were
   removed in Phase 3 Slice 1.
7. **Permission re-export/test surface:** N8 is a re-export ladder left by the
   permission split; N4 is a runtime repository method now used only by tests.
8. **Orphaned tests:** no orphan test file survived. F15's obsolete assignments
   are gone, and remaining old-shape tests are reject-only or migration-history
   evidence. No test should be deleted merely for mentioning a retired shape.

The architecture checker also still reports the already-known AR3/AR5 and
unrelated size-ratchet work (`openapi-schemas.ts`, `apps/core/src/control/server/routes/agents.ts`,
`async-command-task-service.ts`, `agent-spawn.ts`, and the three Telegram
tokens in `apps/core/src/messaging/text-styles.ts`). Those are not relabeled as new findings.

## Recommended Phase-3 execution batch

Run one Phase-3 goal-pipeline cycle with three bounded slices:

1. **Seal Phase 2 first:** correct the ledger/doc/map remnants, resolve the 19
   AR1 settings layer edges without new exceptions, and land N1, N5-N7, and N9.
   This is the precondition for trusting the architecture gate during routing
   work.
2. **Canonical routing invariant:** implement AR2 + F5 + F14 together. Every
   durable writer emits an agent/provider-account-qualified route; one
   application-owned live-route projection derives trigger behavior; the
   external-ref fallback and transient install `trigger` bridge disappear only
   after all writers are cut over.
3. **Disjoint convergence work:** implement F9 as the canonical-job slice, and
   N2-N4 plus N8 as the permission/question cleanup slice. These do not need to
   share a writer with the routing cut, but unified verification must cover all
   slices before commit.

Do not pull AR3/AR4/AR5 or the Phase-6 script deletions into this round. They
remain valid, but mixing public schema generation, CLI ownership, rendering,
and factory-script cleanup into the route cut would weaken the invariant and
the review boundary.

### Phase-3 Surface Impact Matrix

| Surface                     | Classification       | Reason                                                                                                                                                                                                   |
| --------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed              | Qualified route identity and canonical job targets replace fallback selection; question/permission behavior remains equivalent.                                                                          |
| `settings.yaml`             | Unchanged by design  | Phase 2 already removed install trigger/binding copies; Phase 3 deletes only the transient in-memory trigger bridge.                                                                                     |
| Postgres/runtime projection | Changed              | Route rows become qualified, F14's fallback disappears, and job canonical routing fields become required after the approved reset/rewrite.                                                               |
| Control API                 | Unchanged by design  | User-facing bare selectors and ambiguity errors remain; internal live-route projection changes owner/shape.                                                                                              |
| SDK/contracts               | Unchanged by design  | AR3/F4/F17 stay in Phase 4.                                                                                                                                                                              |
| CLI                         | Read-only/observable | Existing commands invoke the canonical route path; provider namespace deletion remains Phase 5.                                                                                                          |
| Gantry MCP/admin skill      | Changed              | `register_agent` must use the canonical install/desired-state writer instead of `registerGroup`.                                                                                                         |
| Channel/provider adapters   | Changed              | Adapters supply provider identity/trigger evidence to the canonical projection; N3 removes duplicate callback validation.                                                                                |
| Docs/prompts                | Changed              | Correct stale paths/migration numbers and document the one-route/one-job authority invariants.                                                                                                           |
| Audit/events                | Read-only/observable | Event kinds stay stable; route/job identifiers become canonical evidence.                                                                                                                                |
| Tests/verification          | Changed              | Add qualified-writer, no-fallback, required-job-field, active-status, callback-reader, and no-stale-path coverage; require architecture, typecheck, focused unit/Postgres tests, and clean-cut searches. |

## Verification performed

- Read the mandatory repository docs, the July 16 audit, execution ledger, and
  bug-pattern preamble.
- Verified branch/worktree state and inspected the full Phase 2 and permission
  cycle file sets.
- Used hidden-inclusive `rg -uu`, tracked `git grep`, current diff/log reads,
  and read-only `ast-grep` call/import searches. Structural searches found zero
  production calls for N1, N5, N6, F11, and N4.
- Attempted `ccc`; the worktree is not initialized. `ccc init`/index would have
  violated the one-output-file contract, so no semantic-index result was used.
- Ran `python3 .codex/scripts/check_architecture.py`; it failed with the
  transitional and already-known findings recorded above.
- No tests or implementation commands were run; this was a read-only audit.

`net: approximately -131 to -141 new lines, -0 deps possible, in addition to the still-valid original phase estimates.`
