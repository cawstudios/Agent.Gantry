# Ponytail Execution Ledger

Date: 2026-07-19

Scope: Phase 1 transition evidence and Phase 2 settings-authority cutover from
`ponytail-audit-2026-07-16.md`.

## Phase 1 transition evidence

### Migration head

- The current migration head is `0104_settings_authority_cutover` (`idx: 104`,
  journal timestamp `1784430700000`).
- The repository has 102 SQL migration files and 102 journal entries, including
  `0104`.
- Head SQL SHA-256:
  `22f9eefe9b1b25eca5b99f64a104a0d4399aea8390194395e89993a461b92cdd`.
- `0104_snapshot.json` SHA-256:
  `6facbe8a9254b3d869dbb202d257a0a9466d1a2e10d0fca7c41dcbc7156baeb3`.
- `0104` is a normal forward migration, not the Phase 7 replacement baseline.
  It adds Conversation-owned `requires_trigger` and drops the invariant
  ConversationInstall `sender_policy` and `control_policy` columns.
- The migration contains no `public` schema qualifier. Tables are referenced
  unqualified, matching the existing migration convention.
- `apps/core/test/unit/storage/postgres-migration-journal.test.ts` passes: 44
  tests.

### Current settings-revision mechanics

- `settings_revisions` is the durable desired-state authority in workstation
  and fleet modes. The current reader version is 14.
- A managed write requires runtime storage, an explicit deployment mode, and a
  settings-revision repository. It validates and normalizes the candidate,
  rejects a stale previous document or expected revision, and skips a no-op
  candidate.
- A real mutation appends with repository-owned compare-and-set semantics at
  `expectedRevision + 1`, records reader version 14, and publishes a Postgres
  revision wakeup. Only after the append succeeds does the workstation path
  synchronize `settings.yaml`, reconcile Postgres/live projection, and reload
  runtime state. A failed projection can therefore retry from the committed
  revision.
- At workstation startup, an existing latest revision wins and restores the
  readable `settings.yaml` mirror. If no revision exists, workstation mode may
  seed revision 1 from the validated file with `expectedRevision: 0`; fleet
  mode does not promote a local file when its revision authority is empty.
- Fleet workers consume the latest revision through NOTIFY plus a poll fallback
  and hold their last applied revision when `min_reader_version` is newer than
  the worker.

### Deployment-mode assumptions

- The parser default is `runtime.deployment_mode: workstation`; the only other
  supported value is `fleet`.
- This ledger records the approved pre-user assumption, not a live runtime or
  database probe: this machine is the only state-preservation target and will
  use the Phase 8 offline restamp. Every other environment resets.
- Before Phase 8, the operator must re-confirm this machine's actual deployment
  mode, latest settings revision, migration stamps, and backup location. A
  fleet-mode or multi-host result invalidates the single-host restamp
  assumption and requires a new cutover decision.

### Phase 8 reset versus restamp sketch

Phase 7 must first publish the final baseline SQL, snapshot, journal entry, and
exact stamp metadata. `0104` is not that baseline.

For this machine only:

1. Stop `com.gantry` and keep the cutover offline.
2. Back up Postgres and `settings.yaml`; capture the latest revision document,
   reader version, and all existing `__drizzle_migrations` stamps.
3. Validate and append the canonical post-cutover settings revision before
   changing migration stamps.
4. Insert the exact Phase 7 baseline timestamp/hash stamp while retaining the
   old stamps for rollback evidence. Do not replay the baseline SQL over the
   already-current schema.
5. Start the service and require exact-head migration validation, revision
   reload/reconciliation, and readiness checks before accepting the cutover.
   Restore the backup if any check fails.

For every other environment: discard the old database, create an empty
database, apply the Phase 7 baseline normally, and bootstrap canonical desired
state. No restamp or legacy-shape import is supported.

## F7 consumer search

The active cutover search covered `providerConnection`,
`provider_connection`, `channel-providerConnection`,
`missing_provider_connection`, and `Provider Connection` across source, tests,
contracts, and architecture docs, excluding generated output and migration
files.

- No current runtime settings type, parser fallback, public contract, Slack
  permission consumer, or control-plane action retains the shadow.
- `settings-revision-legacy-bindings.ts` still recognizes old spellings only as
  the explicitly deferred Phase 9 transition reader (F3).
- `runtime-settings-compact.ts` and focused tests retain old terms only to
  reject unsupported input or prove it is omitted.
- Remaining documentation matches are the audit and historical goal prompt.
  Current architecture vocabulary now says Provider Account.
- Migration-journal tests retain historical table/column names as migration
  evidence.

## Phase 2 outcomes

| Item | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                          |
| ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F6   | Implemented | Removed top-level and per-agent binding/install projections. `conversations.*.installedAgents` is the public/runtime authority, and control-plane/setup consumers now read it directly.                                                                                                        |
| F7   | Adjusted    | Removed the runtime `providerConnection` shadow, fallback reads, obsolete prefix, and current vocabulary. Old spellings remain only in the Phase 9 transition reader, reject-only coverage, and migration/history evidence.                                                                    |
| F16  | Implemented | Removed install-owned `trigger`/`requiresTrigger`; Conversation owns `requiresTrigger`, while install model and permission overrides remain.                                                                                                                                                   |
| F23  | Implemented | Removed invariant install `senderPolicy`/`controlPolicy` from domain, repository, schema, contracts, tests, and writers; `0104` drops the columns. Conversation sender policy and approvers remain authoritative.                                                                              |
| AR1  | Implemented | Moved the existing desired-state service, helpers, types, and current export into `application/settings`; boot, watchers, writer, CLI/control consumers, and reconciliation use that application-owned seam. YAML codecs and revision transport remain in their narrow config/Postgres owners. |

No Phase 2 item was skipped. F7 is adjusted only because the approved plan
keeps F3's transition reader through the short rollback window and removes it
in Phase 9.

### Net line delta

Measured before adding this Phase 1 ledger:

- tracked changes: +631 / -7,382 lines;
- new non-generated `application/settings` source: +1,382 lines;
- Phase 2 non-generated total: +2,013 / -7,382, net **-5,369 lines**;
- generated migration artifacts excluded from that reduction: `0104` SQL +2
  lines and snapshot +14,576 lines.

The exclusion matches the audit's nonmigration estimates and prevents the
generated schema snapshot from hiding the source/test reduction.

## One-time live settings cleanup (deploy prerequisite)

The live machine's `settings.yaml` still contains install-level `trigger` or
`requires_trigger` keys in four real conversations:

- `main_slack_gantry_runtime`
- `main_telegram_dm`
- `main_telegram_group`
- `telegram_default_-1003798366047_0f76daeb32c4`

It also contains roughly 16 stale `codex_test_*` conversations. Before
deploying this cutover, a human operator must translate the four real entries'
trigger configuration to the conversation-level `requires_trigger` field,
remove their install-level trigger keys, and delete the stale test
conversations. This is a manual live-machine cleanup step; the runtime does not
translate the legacy shape.

### Runbook addendum (R6 finding resolution, no-legacy policy)

The 0104 migration derives conversation `requires_trigger` from kind and drops
the per-install columns without preservation code (user directive: no legacy
support). Live-machine audit 2026-07-19: two REAL channels deliberately run
trigger-free and MUST carry `requires_trigger: false` explicitly through the
one-time settings cleanup — `main_telegram_group` and
`telegram_default_-1003798366047_0f76daeb32c4`. The other two real
conversations match kind-derived defaults. All codex*test*\* conversations are
deleted, not migrated.

- Phase 7-9 cutover must restamp unqualified/bare route keys and legacy `memorySubjectJson.route` rows because Slice 2 requires agent/provider-account-qualified keys.

## Phase 3 Slice 1 deferral

- Transient install `trigger` remains until AR2 replaces the legacy route DTO;
  current routing still reads it, so deleting only the in-memory bridge would
  change behavior before the canonical writer cutover.

## Phase 3 Slice 2 outcomes

### Current-tree revalidation

AR2, F5, and F14 all still applied. Slice 1 had already removed the durable
install-trigger projection and qualified the settings desired-state writer,
but the transient install bridge, manual Control/IPC writers, partially
qualified runtime registration, route-selection fallbacks, and Postgres
external-reference fallback all remained.

The legacy runtime record has expanded from the original audit's 51 production
consumers to 94. A mechanical repo-wide record rename would add churn without
removing behavior, so Slice 2 names and enforces `LiveConversationRoute` at the
application projection seam, moves route-key encoding/selection beside it, and
leaves `ConversationRoute` as the internal repository storage record rather
than the canonical writer contract. This is the only current-tree adjustment;
no finding was stale or fully absorbed.

| Item           | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR2            | Implemented | Added one application-owned live-route projection with required agent/provider-account identity and derived trigger behavior; moved route-key selection out of `shared`; preserved thread scope; replaced `MemorySubject.route` with a typed adapter-private payload; merged the one-consumer binding ops service into the Postgres repository; and routed `register_agent` through the revision-first ConversationInstall writer. |
| F5             | Implemented | Every durable writer now emits an agent/provider-account-qualified key. Runtime registration rejects non-app routes without provider-account identity, and selection/recovery no longer falls back to route payload identity, folder identity, bare keys, or partially qualified duplicates.                                                                                                                                       |
| F14            | Implemented | Canonical binding reads no longer select or parse Conversation external refs and reject an empty `conversation-route:` suffix instead of reconstructing a JID.                                                                                                                                                                                                                                                                     |
| Trigger bridge | Implemented | Removed transient install `trigger`, IPC/MCP registration trigger input, free-form CLI trigger input, writer copies, and adapter-private persisted trigger text. Trigger text is derived once from the agent display name; Conversation remains authoritative for `requiresTrigger`.                                                                                                                                               |

The Phase 9 transition reader still recognizes legacy revision `binding.trigger`
as explicitly planned. It is not a live settings/runtime bridge and remains
until the rollback window closes.

### Surface impact

| Surface                     | Classification      | Reason                                                                                          |
| --------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed             | Route identity is canonical and trigger text is derived.                                        |
| `settings.yaml`             | Unchanged by design | Slice 1 already removed install trigger; current writes still use revision-first desired state. |
| Postgres/runtime projection | Changed             | Binding rows require canonical route suffixes and Conversation-owned trigger policy.            |
| Control API / SDK contracts | Unchanged by design | No public route contract changed.                                                               |
| CLI / Gantry MCP tools      | Changed             | Custom trigger text was removed; registration writes ConversationInstall desired state.         |
| Channel/provider adapters   | Changed             | Setup writers persist qualified routes through the central projection.                          |
| Audit/events                | Unchanged by design | Existing desired-state and registration audit paths remain authoritative.                       |
| Tests/verification          | Changed             | Legacy-key/fallback cases were deleted and canonical identity invariants added.                 |

### Net line delta

Mutually exclusive path attribution for source and tests is AR2 +578/-363,
F5 +459/-687, F14 +52/-79, and trigger-bridge removal +58/-104: total
+1,147/-1,233, net **-86 lines**. The required ledger and audit-path updates
add +68/-3 documentation lines, making the complete uncommitted worktree delta
+1,215/-1,236, net **-21 lines**.

### Verification notes

- Focused routing matrix: 16 files, 416 tests passed; the additional
  `ipc-interaction-handler` canonical-key fixture rerun passed 37 tests.
- Full-unit broad run: 511 files / 6,324 tests passed. The remaining unrelated
  failures were isolated to the sandbox's denied FSEvents watchers (`EMFILE`)
  and `npm pack`'s denied write to the primary checkout's `.git/config` during
  Husky prepare; the exact `npm run test:unit` run stalled after the same
  watcher exhaustion and was terminated after bounded waits.
- Architecture checker before and after Slice 2 reports the same 11 current-tree
  findings: five size ratchets, one existing control agent-route layer edge, three
  Telegram text-style findings, and two active-doc references. The task's
  stated eight-finding baseline omitted the newly merged prompt-profile ratchet
  and two active-doc references; Slice 2 added no finding or exception.

## Phase 3 Slice 3 outcomes

### Current-tree revalidation

F9, N2, N3, N4, and N8 all still applied after Slices 1-2 and the merged
conversation-quality, permission-prompt schema, attachment, messaging-cleanup,
and gateway-latency changes. None was fully or partially absorbed: the job
model still allowed missing canonical execution/delivery fields and rebuilt
them from legacy mirrors, question selections were still decoded twice, Slack
and Teams still carried separate durable callback readers, the unused pending
interaction list port still crossed every layer, and the prompt-binding module
still re-exported unrelated callback types.

| Item | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                                                              |
| ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F9   | Implemented | Made `execution_context` and non-empty `notification_routes` the only job execution/delivery authority; deleted top-level/session/route reconstruction and route-source aliases; required canonical rows at Postgres read/write boundaries; preserved provider-account identity in system-job targets and registration signatures. |
| N2   | Implemented | Removed the second raw selection decoder and builds the durable selection map directly from the already-validated pending-interaction envelope.                                                                                                                                                                                    |
| N3   | Implemented | Consolidated Slack and Teams durable question callback recovery into one application-owned reader; channel adapters now keep only channel-specific rendering/parsing.                                                                                                                                                              |
| N4   | Implemented | Deleted the zero-production-consumer `listPendingInteractions` port, Postgres implementation, mocks, and tests; recovery continues through the existing idempotency-key lookup.                                                                                                                                                    |
| N8   | Implemented | Removed prompt-binding callback/type re-exports and changed consumers to import each type or reader from its owning module.                                                                                                                                                                                                        |

F9 intentionally adds no compatibility reader or migration shim. The approved
Phase 8 reset/restamp must leave every retained job with canonical execution
context and at least one notification route before this fail-loud reader is
deployed; other environments reset.

### Surface impact

| Surface                     | Classification       | Reason                                                                                                           |
| --------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed              | Jobs execute and notify only from canonical context/routes; durable question recovery has one reader.            |
| `settings.yaml`             | Unchanged by design  | These findings do not change desired-state configuration or its authority.                                       |
| Postgres/runtime projection | Changed              | Job reads/writes reject missing canonical fields; the unused pending-interaction list repository method is gone. |
| Control API                 | Read-only/observable | Existing job responses consume canonical visibility metadata; no public request or response shape changed.       |
| SDK/contracts               | Unchanged by design  | No provider SDK or public contract changed.                                                                      |
| CLI                         | Unchanged by design  | No CLI surface reads the removed fallbacks or pending-interaction list.                                          |
| Gantry MCP/admin tools      | Unchanged by design  | Existing job writers already supply canonical context/routes; no tool schema changed.                            |
| Channel/provider adapters   | Changed              | Slack and Teams share the application callback reader; Discord imports the callback type from its owner.         |
| Docs/prompts                | Changed              | This ledger records the cutover prerequisite and current-tree outcome; prompts are unchanged.                    |
| Audit/events                | Unchanged by design  | Existing job and interaction audit/event payloads remain authoritative.                                          |
| Tests/verification          | Changed              | Fallback/list tests were deleted and canonical fail-loud/provider-account invariants were added.                 |

### Net line delta

Mutually exclusive source-and-test attribution is F9 +342/-290 (net **+52**;
production alone +116/-233, net **-117**), N2 +9/-37 (net **-28**), N3
+33/-51 (net **-18**), N4 +33/-95 (net **-62**), and N8 +10/-20 (net
**-10**): total +427/-493, net **-66 lines** before this ledger section.

### Verification notes

- Typecheck passed after the final production/test change.
- Focused job/interaction matrix: 14 files, 624 tests passed; the two stale F9
  fixtures discovered by the first full run were corrected and reran in
  isolation with 75 tests passed. The N2/N3/N4/N8 subset independently passed
  six files / 474 tests.
- Autoreview found one provider-account restamp gap for dead-lettered system
  jobs. Both per-conversation and singleton registrations now refresh canonical
  targets without reviving the job; the focused regression file passed 16
  tests and typecheck passed again.
- The exact full `npm run test:unit` command was run three times. The first run
  found the two stale F9 fixtures above. After their isolated green rerun, both
  the second run and the final post-review-fix run emitted no failing test but
  did not exit or print Vitest's final summary after bounded waits, so they were
  terminated as load/open-handle stalls rather than reported as clean
  full-suite completions.
- Postgres integration startup is blocked in this symlinked worktree because
  Vitest cannot create `node_modules/.vite-temp` (`EPERM`); no integration test
  body ran, so focused unit coverage is the verification evidence for N4.

## Phase 4 outcomes

### Current-tree revalidation

AR3, F4, and F17 all still applied after Phase 3 and the intervening merged
changes. Canonical Zod schemas already owned the model/default/preview,
agent-profile, runtime-settings, and ConversationInstall shapes, but Control
OpenAPI still hand-copied or omitted them. The SDK then hand-copied the model,
profile, runtime-settings, and desired-state types from that incomplete public
description.

Independent re-review then found four residual contract-to-SDK drifts in the
first Phase 4 pass: install responses still emitted removed trigger-policy
fields; the shared install request advertised path-owned identity and
unsupported metadata; the model workload enum still had two definitions; and
the SDK model list return retained one handwritten response mirror. All four
were removed in this review-fix pass.

The required pre-change consumer search covered `apps/`, `packages/`,
`.github/`, and their nested tests. This checkout has no top-level `tools/`,
`test/`, or `tests/` directory. The findings were:

- the F4 handwritten model/default/preview types were consumed by the SDK
  model client and root exports; richer job-only records remain distinct and
  were preserved;
- the F17 handwritten profile types were local to the SDK agent client;
- the SDK settings client was the only handwritten consumer of the existing
  runtime-settings and desired-state response shapes;
- the enable/update routes need a strict route-specific install request because
  app, agent, and conversation identity comes from the authenticated path, and
  install metadata is not persisted;
- stale install memory-route trigger fields had one remaining response mapper,
  one desired-state writer, one agent-list reader, and one application merge
  path even though Conversation now owns `requiresTrigger` and channel trigger
  derivation;
- `apps/core/src/cli/model-preview-types.ts` and the shared runtime
  `ModelWorkload` are internal CLI/runtime shapes, not duplicate public SDK
  declarations, and remain unchanged.

| Item | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR3  | Implemented | Added one Zod-registry projection for canonical contract components; projected model, profile, runtime-settings, desired-state/revision, AgentHarness, and ConversationInstall schemas; documented the existing desired-state routes; generated SDK aliases from operations; and added the generated check to CI. The route request is now a strict canonical schema that omits path-owned identity and unsupported metadata. Install responses expose only `agentConfig` in `routeConfig`. |
| F4   | Implemented | Deleted handwritten SDK model/default/preview declarations and the handwritten OpenAPI copies. Generated aliases now preserve the complete model contract. `ModelWorkloadSchema` is defined once and referenced by `ModelRecordSchema`, and `models.list()` returns generated `ListModelsResponse`. Existing memory-preview diagnostics remain canonical, while provider-neutral `modelRoute.id` remains an open string.                                                                    |
| F17  | Implemented | Deleted handwritten SDK profile declarations and projected the canonical strict profile schemas, including nonnegative integers, the content length limit, and the profile-kind path parameter.                                                                                                                                                                                                                                                                                             |

No Phase 4 item was skipped. The review fix changes only the install request
validator, response projection, and trigger-policy source needed to make the
runtime behavior match the canonical public contract. It does not add install
metadata persistence or restore install-level trigger policy.

### Surface impact

| Surface                     | Classification       | Reason                                                                                                                                                         |
| --------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed              | Enable/update rejects ignored identity/metadata fields, install saves strip stale route policy, and agent-list trigger policy reads Conversation.              |
| `settings.yaml`             | Unchanged by design  | The cutover does not add or remove desired-state fields in the human-readable settings surface.                                                                |
| Postgres/runtime projection | Changed              | Desired-state reconciliation no longer mirrors Conversation `requiresTrigger` into install memory-route state; live routes still receive it from Conversation. |
| Control API                 | Changed              | OpenAPI projects the strict route request and agentConfig-only route response that the handlers honor.                                                         |
| SDK/contracts               | Changed              | Route-specific request, single workload schema, generated model-list response, and regenerated operation declarations remove the hand mirrors.                 |
| CLI                         | Unchanged by design  | The internal CLI preview formatter/types are not public SDK contracts and remain in place.                                                                     |
| Gantry MCP/admin tools      | Unchanged by design  | No MCP/admin tool schema or capability selection changed.                                                                                                      |
| Channel/provider adapters   | Read-only/observable | Existing live route registration observes Conversation-owned trigger policy; provider transports and rendering are unchanged.                                  |
| Docs/prompts                | Changed              | This ledger records the review fixes; prompts and product guidance are unchanged.                                                                              |
| Audit/events                | Unchanged by design  | Existing control/settings/profile audit and event paths remain unchanged.                                                                                      |
| Tests/verification          | Changed              | Contract, OpenAPI, mapper, route validation, desired-state, and onboarding regression coverage locks the corrected shapes and ownership.                       |

### Net line delta

Measured before adding this ledger section:

- non-generated source, tests, and CI: +681/-915, net **-234 lines**;
- regenerated SDK declaration: +873/-453, net **+420 lines**;
- complete Phase 4 code/test/generated delta: +1,554/-1,368, net **+186
  lines**.

The generated declaration expanded because previously inline or incomplete
OpenAPI copies now expose the full canonical runtime-settings/model shapes and
new desired-state operations. Regeneration also absorbed pre-existing
`missing_provider_connection` to `missing_provider_account` drift already
present at Phase 4 start.

### Verification notes

- `npm run build:contracts`, `npm run build:sdk`, and `npm run typecheck`
  passed after the review fixes.
- Final focused contract/OpenAPI/mapper/install-service/desired-state/route-
  validation matrix: six files, 160 tests passed. The focused onboarding
  integration file also passed all five tests in the final worktree-safe
  non-bundling config-loader run.
- The definitive full unit run,
  `npm run test:unit -- --pool=forks --maxWorkers=4 --retry=2 --reporter=dot`,
  passed all 518 files and 6,424 tests in 1,963.88 seconds. An earlier
  eight-worker diagnostic run passed 517 files and 6,418 tests but timed out
  six unrelated spawned-runner cases; the two different cases that timed out
  in an isolated rerun both passed when rerun directly before the clean full
  run.
- The exact workspace generated check cannot resolve new worktree-local
  contract exports through this checkout's shared `node_modules` symlink: it
  loads the primary checkout's built `@gantry/contracts`. The same generator
  was run with a temporary worktree-local `tsx` path mapping; generation and
  its final `--check` comparison passed. CI now runs the exact
  `npm run check:generated --workspace @gantry/sdk` command in a normal
  checkout after build.
- `npm run format:check` and `git diff --check` passed.
- Architecture checking began with 16 current-tree findings: ten file-size
  ratchets, one existing control-route layer edge, three Telegram text-style
  findings, and two active-doc references. It ends with the same baseline
  except that `openapi-schemas.ts` is now below its size budget: 15 findings,
  no new finding or exception.
- Independent re-review found the four residual drift defects described above;
  this outcomes update records their fixes. Re-review of the resulting
  uncommitted work remains pending by request.

## Phase 5 outcomes

### Current-tree revalidation

AR4, AR5, F13, and F20 all still applied after Phase 4 and the intervening
merged changes. The required repo-wide consumer searches covered `apps/`,
`packages/`, `docs/`, and `.github` before each cut. This checkout still has no
top-level `tools/`, `test/`, or `tests/` directory.

The searches found that provider-account connect/rotate/install and
Conversation info/approver behavior still lived in the CLI adapter; canonical
conversation commands still delegated into undocumented provider aliases;
messaging/runtime still rendered Slack and Telegram dialect text before
persistence and channel delivery; the provider registry still advertised a
formatting policy; and the legacy Slack thread prefix still had one acceptance
test plus stale integration fixtures. Slack and Discord permission-interaction
registration also still dominated their oversized general interaction files.

Post-change searches leave the removed provider aliases and `thread:slack:`
only in rejection tests or historical audit evidence. Removed generic-renderer
names remain only in historical documents. No Phase 6 deletion or Phase 7-9
cutover item was pulled into this phase.

| Item                   | Outcome     | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AR4                    | Implemented | Added application-owned provider-account, ConversationInstall, summary, and approver use cases; the CLI now only parses, invokes, and formats. Authority writes remain revision-first through desired state, approver validation records canonical participants before the write, and canonical external identity segments are collision-free for all newly restamped rows. Existing pre-restamp identity rows intentionally receive no compatibility reader or migration in this phase; the approved Phase 8 offline restamp owns that cutover. |
| AR5                    | Implemented | Runtime/messaging now strips only internal tags and persists canonical visible text. Slack and Telegram render and plan provider-sized chunks at their adapter boundaries. Retry tails stay canonical across direct and streaming partial delivery; Slack native appends are token-aligned, whitespace-lossless, and use a linear canonical/rendered segment map. The provider registry formatting field and generic renderer were deleted.                                                                                                      |
| F13                    | Implemented | Deleted undocumented `provider info`, `provider control-allowlist`, and `provider approvers`; retained only canonical Conversation info/approver commands backed by the application service.                                                                                                                                                                                                                                                                                                                                                     |
| F20                    | Implemented | Deleted accepted `thread:slack:` compatibility and normalized active fixtures. The stale prefix remains only in an explicit rejection test and audit history.                                                                                                                                                                                                                                                                                                                                                                                    |
| Slack/Discord file cut | Implemented | Split permission-interaction registration into owned Slack and Discord files and added an architecture boundary test. The resulting general/permission files are 89/515 lines for Slack and 315/402 for Discord.                                                                                                                                                                                                                                                                                                                                 |

### Surface impact

| Surface                     | Classification      | Reason                                                                                                                                                        |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed             | Canonical text persists before adapter rendering; partial-delivery retry tails remain canonical; provider/conversation mutations use application services.    |
| `settings.yaml`             | Changed             | Existing provider-account, install, and approver writes keep the same readable schema but now go exclusively through revision-first desired-state operations. |
| Postgres/runtime projection | Changed             | Validated approvers are recorded as canonical participants and outbound message/event text is canonical; no schema or migration changed.                      |
| Control API                 | Unchanged by design | Existing control routes and application service contracts are unchanged by the CLI/adapter cut.                                                               |
| SDK/contracts               | Unchanged by design | No public contract or generated SDK surface changed, so an SDK rebuild is not required.                                                                       |
| CLI                         | Changed             | Provider aliases were deleted and remaining provider/conversation commands invoke application-owned use cases.                                                |
| Gantry MCP/admin tools      | Unchanged by design | No tool schema, capability, or admin-tool path changed.                                                                                                       |
| Channel/provider adapters   | Changed             | Slack/Telegram own rendering and chunk planning; Slack/Discord permission registration is split by responsibility.                                            |
| Docs/prompts                | Changed             | Architecture/audit references and this ledger describe the new ownership; agent prompts are unchanged.                                                        |
| Audit/events                | Changed             | Existing event shapes remain, but persisted outbound visible text is now canonical rather than provider-rendered.                                             |
| Tests/verification          | Changed             | Canonical rendering/retry, application ownership, alias rejection, thread-prefix rejection, participant identity, and split-boundary invariants are covered.  |

### Net line delta

Measured before adding this ledger section, tracked files are +1,016/-1,617
and six new source/test files add 1,670 lines: complete Phase 5 code, test, and
supporting-doc delta +2,686/-1,617, net **+1,069 lines**. The positive delta is
primarily the application-owned provider/conversation use-case seam, the shared
canonical chunk/retry planner, and regression coverage; the Slack/Discord
physical splits preserve behavior instead of claiming moved lines as deletion.
No dependency was added.

### Verification notes

- `npm run typecheck` passed and includes a successful
  `npm run build:contracts`. No contracts changed, so `build:sdk` was not run.
- Final focused provider/conversation/rendering matrix: nine files, 472 tests
  passed. Phase 5 source lint passed with zero errors and 39 existing-style
  warnings. Whole-repo lint remains blocked by the unrelated baseline of 23
  errors and 999 warnings.
- The definitive full unit run is recorded below after completion.
- The focused onboarding integration file could not start in this symlinked
  worktree: the standard loader was denied writing `node_modules/.vite-temp`
  (`EPERM`), the runner loader evaluated CommonJS `__dirname` as undefined, and
  the native loader could not resolve `vitest.shared.js`. No integration test
  body ran.
- Architecture checking began with 15 production findings: nine file-size
  ratchets, one existing control-route layer edge, three provider-specific
  Telegram findings in the generic renderer, and two active-doc references.
  It ends with 12 production findings: the same nine size ratchets, layer edge,
  and two active-doc references. The checker additionally reports two stale
  exception-hygiene entries for the deleted renderer; the sandbox makes
  `.codex/architecture-exceptions.json` read-only, so those entries could not be
  removed here. Phase 5-created Slack/Telegram size ratchets were reduced below
  their existing budgets before closeout.
- Local autoreview drove consolidation of two recurring invariants: approver
  validation now records collision-free canonical participant/user/alias
  identity before revision-first settings projection, and all Slack/Telegram
  delivery/retry producers use canonical text with token-aware provider
  planning. Final review left one deliberate P2 requesting migration of
  pre-restamp identity rows; that is rejected for this phase because the
  approved plan and user direction prohibit compatibility work and assign the
  only preserved machine to the Phase 8 offline restamp.

## Phase 6 outcomes

### Current-tree revalidation and consumer searches

Before each proposed deletion, exact-name consumer searches covered `apps/`,
`packages/`, `docs/`, and `.github`; `.codex` was also searched for the factory
scripts that live there. Structural `ast-grep` searches supplemented the exact
searches for F11, F18, and F24. `ccc` was unavailable because this disposable
worktree is not initialized, and initializing it would create files outside the
bounded Phase 6 write scope.

| Item | Current-tree consumer evidence                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2   | The archived-memory importer name appears only in the July audit documents; there is no caller, prompt, workflow, or package script.                                                                                                                     |
| F8   | The flag-based test recorder name appears only in the July audit documents; current factory surfaces use `record_test_from_json.py`.                                                                                                                     |
| F10  | The Postgres wrapper name appears only in audit documents and its own usage string; current docs invoke Vitest with `GANTRY_TEST_DATABASE_URL` directly.                                                                                                 |
| F11  | `_memorySubjectFromRow` had only its declaration and zero structural calls.                                                                                                                                                                              |
| F12  | The GitHub wrapper name appears only in the July audit documents; there is no workflow, prompt, or script caller.                                                                                                                                        |
| F15  | No dynamic `defaultConnection` assignment returned. Remaining matches are reject-only coverage, historical migrations/tests, and audit/goal history.                                                                                                     |
| F18  | `fallbackForInjectedRunner` was confined to the job resolver and its execution caller; `fallbackExecutionProviderId` was confined to the shared resolver and its two job callers. Injected `runAgent` remains a test seam, not provider-authority input. |
| F19  | Current recorder callers use canonical finding flags/JSON keys. No caller uses `--blocking`, `--warning`, `blocking`, or `warnings`; the compatibility reads/emits exist only in the three target scripts.                                               |
| F21  | No repository consumer imports `@gantry/contracts/primitives`. Internal imports use the retained canonical contract-primitives artifact rather than the duplicate package export alias.                                                                  |
| F22  | The no-op hook name appears only in audit documents and the hook-contract assertion that it is not configured.                                                                                                                                           |
| F24  | `MemoryScope` and `MemorySearchResult` are not imported through `domain-types.ts`; real consumers import the memory-owned types directly. The matching architecture exception is still present.                                                          |

No finding gained a new consumer. F15 remains absorbed by earlier work. The
implementer sandbox exposed `.codex` as read-only, so seven findings were first
recorded blocked; the orchestrator (with repository write access) completed
them in the same phase using the consumer evidence above. The outcome table
below records the final state.

| Item | Outcome     | Evidence and boundary                                                                                                                                                                                                                            |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F2   | Implemented | Deleted `.codex/scripts/migrate_archived_filesystem_memory.mjs` (418 lines, no caller).                                                                                                                                                          |
| F8   | Implemented | Deleted `.codex/scripts/record_test_result.py`; `record_test_from_json.py` is the sole recorder.                                                                                                                                                 |
| F10  | Implemented | Deleted `.codex/scripts/run_postgres_integration_with_url.mjs`; docs invoke Vitest with `GANTRY_TEST_DATABASE_URL` directly.                                                                                                                     |
| F11  | Implemented | Deleted the uncalled Postgres row-to-memory-subject helper; the existing live `MemorySubject` parser/import remains.                                                                                                                             |
| F12  | Implemented | Deleted `.codex/scripts/sync_github.py` (unconsumed `gh` wrapper).                                                                                                                                                                               |
| F15  | Absorbed    | Earlier work already removed all stale dynamic assignments; reject-only and migration-history evidence remains intentionally.                                                                                                                    |
| F18  | Implemented | Deleted injected-runner provider-ID fallbacks from normal and dead-letter job resolution. Catalog routing and registered adapter/registry resolution remain authoritative; `runAgent` injection still controls only the spawned runner in tests. |
| F19  | Implemented | Removed `--blocking`/`--warning` flags, legacy JSON key reads, and legacy emit keys from `record_review.py`/`record_review_from_json.py`; `factory_gates.py` reads only `blocking_findings`. Factory tests (135) pass.                           |
| F21  | Implemented | Deleted only the unused `./primitives` package export alias and retained `./contract-primitives` plus all internal canonical imports.                                                                                                            |
| F22  | Implemented | Deleted the no-op `.codex/scripts/post_tool_use.py`; the hook contract's assertNotIn guard still passes.                                                                                                                                         |
| F24  | Implemented | Removed the `MemoryScope`/`MemorySearchResult` re-exports from `domain-types.ts` AND the paired `forbidden_import_by_layer` exception entry; consumers import the memory-owned types directly.                                                   |

No Phase 7-9 item, settings-authority seam, canonical-routing seam, public DTO,
or Phase 5 rendering/adapter path changed.

### Surface impact

| Surface                     | Classification      | Reason                                                                                                                                       |
| --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Unchanged by design | F11 was dead and F18 removes only injected-runner provider authority; production catalog/registered-adapter resolution is unchanged.         |
| `settings.yaml`             | Unchanged by design | Phase 6 does not read, write, or project desired settings.                                                                                   |
| Postgres/runtime projection | Unchanged by design | The removed Postgres helper had zero calls; no repository contract, schema, row, or migration changed.                                       |
| Control API                 | Unchanged by design | No Control route, validator, response, or application use case changed.                                                                      |
| SDK/contracts               | Changed             | Package metadata no longer exposes the unused `./primitives` alias; the canonical `./contract-primitives` subpath and contract types remain. |
| CLI                         | Unchanged by design | No CLI command or implementation consumes the completed deletions.                                                                           |
| Gantry MCP/admin skill      | Unchanged by design | No tool schema, capability, prompt, or admin surface changed.                                                                                |
| Channel/provider adapters   | Unchanged by design | No channel/provider adapter or Phase 5 rendering seam changed.                                                                               |
| Docs/prompts                | Changed             | This ledger records current consumer evidence, outcomes, blocked boundaries, and verification.                                               |
| Audit/events                | Unchanged by design | No audit/event kind, payload, persistence, or delivery behavior changed.                                                                     |
| Tests/verification          | Changed             | Focused job/provider-resolution checks cover F18; final typecheck, unit, architecture, and completion results are recorded below.            |

### Net line delta

Before this ledger section, the implemented source/package changes are
+0/-49, net **-49 lines**: F11 -32, F18 -12, and F21 -5. The orchestrator
completion adds the `.codex` deletions (F2 -418, F8 -51, F10 -32, F12 -26,
F22 -3), the F19 alias removal (~-24), the F24 re-export + exception removal
(-12), and the dated-snapshot doc-reference rule in
`architecture_rules.py` (+8) — Phase 6 total net approximately **-620 lines**.
No dependency was added or removed.

### Verification notes

- Prettier was run on every touched supported file; unsupported/deleted paths
  were passed through the worktree-safe `--ignore-unknown` invocation.
- F18 focused execution/model-resolution tests passed: 48 tests.
- Final `npm run typecheck` passed, including `npm run build:contracts`.
- The requested direct unit command could not create the shared symlink target's
  `node_modules/.vite-temp` (`EPERM`) before test discovery. An equivalent
  worktree-local Vitest config preserved the unit includes, aliases, setup, and
  timeout; its temporary verifier also isolated npm cache/Husky writes and
  forced Gantry's existing polling fallback because this sandbox denies the
  FSEvents lookup used by `fs.watch`. The temporary files were removed after
  the run. Final result: 519 files and 6,442 tests passed in 923.91 seconds,
  exit 0.
- The architecture checker reports the existing baseline only: nine file-size
  ratchets, one control-route layer edge, and one active-doc reference (the
  undated artifact-store goal prompt). Deleting `.codex` scripts named by the
  dated audit snapshots would otherwise create ~17 broken-link findings, so
  `check_doc_references` now skips dated snapshot docs
  (`DATED_SNAPSHOT_DOC_RE`): a dated audit describes the tree as of its date
  and files it names may legitimately be deleted later. This also retired the
  prior outbound-attachments baseline entry (dated doc). Factory script tests:
  135 pass after the F19/F22 edits and the rule change.
