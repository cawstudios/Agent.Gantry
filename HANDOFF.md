# HANDOFF — deployment-modes branch (2026-06-11)

Session handoff for continuing on another machine. Delete this file once the
items below are absorbed into PRs/issues. Branch: `feature/deployment-modes`
(16 commits on top of `feature/mworker-01-safe-multi-worker-execution`'s
`bdf86d2f`). Working tree committed clean; pushed.

## What is DONE (implemented, adversarially reviewed, committed, gates run)

| Phase | Content | Commits |
|---|---|---|
| 0 | 5 ADRs (`docs/decisions/2026-06-11-*.md`), `docs/architecture/deployment-profiles.md`, `TODOS.md` | `3ca459a0` |
| 1 | Locked agent preset: `agents.<id>.access.preset: full\|locked`; parent-side denial on BOTH IPC ingestion loops (`denied_by_profile`), tri-state fail-closed lock lookup, `permissionMode: deny`, CLI verb. Later extended: policy-aware instruction projection + provisioned-only introspection for locked agents | `697cde1c`, `193710d1`, `5ba942ce` |
| 2 | Packaging: `/healthz` `/readyz` `/metrics`; SIGTERM drain (`runtime.queue.drain_deadline_ms`); load-bearing lease-elected live host (in-process standby takeover); Node 24 image (python3 + bubblewrap, non-root); advisory-locked migrations (single lock incl. boot-time); GHCR CI w/ SBOM+Trivy; Terraform (network/db/storage/secrets/worker_pool/control + fleet/support envs); AWS runbook | `160e2c2f`, `5a1a6760` |
| 3 | Fleet capability state: migration 0077 (`runtime_dependencies`, `settings_revisions`); S3 artifact driver (sha256, quarantine); npm bake jobs (`--ignore-scripts`, registry-pinned, idempotent, reaper-recovered); worker reconciler + `capabilities_json` advertising; capability-matched dispatch (requeue w/o retry burn, recovery filter, fleet-wide-only readiness pause, starvation alert+pause); settings revisions + desired-state control API + SDK; CLI (`settings validate\|import\|export\|drift\|revisions`, `workers list`, `bake status\|rebake`, `artifacts quarantine list\|purge\|rebake`); fleet boot gated on first revision; `GANTRY_SECURITY_POSTURE` rename (clean cut) | `f20ba11a`, `c4f22aac`, `4bfae3b0`, `f5d95ece`, `2e03596e`, `8be9014c`, `89d4a2dc` |
| Ops/docs follow-ups | Single autoscaled fleet pool (lease elects live host; min ≥ 2); CPU target-tracking autoscaling; worker-configuration reference (sandbox resource limits + sizing rule); vertical-vs-horizontal scaling decision guide | `3793eeec`, `d5b2454b`, `f005605d` |

Review trail: per-phase adversarial Opus reviews. Found+fixed pre-commit: Phase 1
permission-loop authority bypass (P0-class) and fail-open lock lookup; Phase 2
decorative live-host lease (P1); Phase 3 stuck-`baking` rows never recovering +
SIGTERM-mid-bake stranding (2×P0), settings 409 check-then-act race (P1), plus
P2s (quarantine path collision, locked-projection residuals, rebake CAS).
Security verdict: CLEAN. Hard gates at `f005605d`: `npm run build` clean;
`npm test` 3581/3582 (see Pending #3). Postgres integration suites proven
against a disposable pgvector container.

User decisions binding on all future work (see also memory/ADRs): no skill
versioning; YAML is ONLY the personal/workstation+CLI-file surface; no legacy
affordances ever (no deprecation aliases, no rename guards); Terraform/AWS
first; single autoscaled pool; Go toolchain stays out of the image.

## PENDING (in priority order)

### 1. Settings wire contract: replace YAML strings with the typed document (IN FLIGHT, work discarded cleanly — restart fresh)
The desired-state API/SDK currently transports `settingsYaml` strings
(`routes/settings.ts`, `packages/sdk`). User ruling: WRONG — YAML is the human
file format for workstation + CLI `--file` edges only; the API/SDK/future UI
speak the typed JSON settings document (the same shape `settings_revisions`
already stores as jsonb; validated by the shared `@gantry/contracts` schema).
Full spec for the implementing agent:
- `GET /v1/settings/desired-state` → `{revision, minReaderVersion, settings: <document>, createdBy, note, updatedAt}`; `PUT/POST` accepts `{settings, expectedRevision?, note?}`; 400 `INVALID_SETTINGS` errors are document-path-level; 409 semantics unchanged.
- SDK methods typed with the contracts settings types, not string.
- CLI `settings import --file <yaml>` parses YAML at the CLI edge → document → same service path; `export` renders YAML from the document. Watcher unchanged.
- `settings-import-service.ts`: one validation path; YAML→document conversion used only by CLI/watcher callers.
- Fleet boot/revision listener unchanged (consume the stored document; local render-to-settings.yaml is an internal loader reuse — comment it as non-contract).
- Tests: route document in/out + 400/409; CLI YAML round-trip; SDK types compile. Grep repo for `settingsYaml` afterward.
Note: an earlier partial attempt added docs/sdk sections documenting the OLD
`settingsYaml` contract; those edits were discarded — do not resurrect them.

### 2. SDK docs update (`docs/sdk/**`) — AFTER item 1 lands
Six files (overview, quickstart-nestjs, quickstart-nextjs, webhooks,
agent-internals, api-reference) predate this branch. Verify every claim against
source, then update:
- overview.md: "Deployment shapes" — same-machine (workstation sidecar, compose; parent + child runners co-located) vs separated-to-scale (fleet: control API behind ALB, N worker processes/machines, RDS+S3); SDK code identical in both — only base URL + key provisioning change. Fix the "Unix socket by default" transport claim for the fleet case. Add the desired-state surface (typed document per item 1).
- quickstarts: customer-facing example agents use `access.preset: locked` (one sentence why); "Going to production" closer → AWS runbook + Scaling Decision Guide; Next.js keeps SDK strictly server-side.
- api-reference.md: verify existing entries; ADD desired-state section (document contract, scope per routes/settings.ts, 409/400 semantics, one optimistic-concurrency example) + the operational endpoints (/healthz /readyz /metrics, unauthenticated, not on public ALB).
- agent-internals.md: short locked-preset note (tools unmounted child-side; parent-side denial is the boundary; instructions stripped) linking the ADR.
- Everywhere: `GANTRY_DEPLOYMENT_MODE` must not appear (renamed `GANTRY_SECURITY_POSTURE`; topology is the `runtime.deployment_mode` SETTING — different axes).
- User's explicit ask: make it clearly answer "how do I run gantry+runtime on one machine vs separately to scale" for NestJS/Next.js builders.

### 3. Pre-existing BASE-BRANCH defects (block merge gates; owned by `feature/mworker-01-safe-multi-worker-execution`, NOT this branch — both verified to fail with this branch's work stashed)
- `apps/core/test/unit/runtime/message-loop.test.ts` "passes non-self sender ids with continuation batches" — fails at `bdf86d2f`; blocks `npm test`.
- `apps/core/test/integration/live-horizontal-execution.integration.test.ts` "delivers prompt resolutions to the recovered owner after adapter restart" — fails at base under Postgres; possible real durability bug (`interaction_resolved` command not enqueued after adapter restart + takeover). Ticket-worthy.

### 4. Plan acceptance items never executed
- Measured runbook walkthroughs: local compose → first turn ≤ 15 min; clean AWS account → first locked support-agent turn ≤ 60 min. Documented, never timed end-to-end.
- Chaos-combo integration test from the plan's Phase 3 list (bake completes + NOTIFY + instance refresh simultaneously) and the ONE two-process e2e — unit/integration coverage exists per subsystem; the combined chaos scenario and a true two-process e2e were not built.
- Real AWS deploy has never been applied (terraform validate-only so far).

### 5. Phase 4 (explicitly OUT of plan — future)
Multi-live GroupQueue cutover (live chat horizontal scaling). Criteria recorded
in `docs/decisions/2026-06-11-deployment-modes.md`; pull forward if a
public-facing deployment expects real live-chat traffic. Browser profile
snapshot/restore becomes necessary with it.

### 6. TODOS.md near-term flags (full list in TODOS.md, each with triggers)
- Fleet container sandbox enablement (`sandbox_runtime` in Docker: seccomp/userns + doctor check) — REQUIRED before the first production fleet running public-facing agents; until then fleet keeps `runtime.sandbox.provider: direct`.
- Locked-agent unmet-need telemetry + human handoff (support product layer) — locked agents currently produce zero demand signal.
- pip bake lane; pinned-binary bake lane; CLI dry-run missing-OS-dep report; live-conversation auto-resume after bake; subagent-aware run slots; fleet management UI on the desired-state API.

### 7. Merge path
PR `feature/deployment-modes` → likely stacked on `feature/mworker-01-...`
(this branch contains it). Repo hard gates (AGENTS.md): `npm run build`,
`npm test` (blocked by Pending #3), `python3 .codex/scripts/verify.py`,
`python3 .codex/scripts/validate_artifacts.py --allow-missing-run`. The repo's
Codex-factory artifacts (`.factory/*`) were NOT produced — this work ran as a
reviewed-subagent implementation; produce them or waive per team policy.

## Context locations
- Repo-resident truth: ADRs `docs/decisions/2026-06-11-*.md`; `docs/architecture/deployment-profiles.md` (mode matrix, worker config, scaling guide); `docs/deployment/aws-terraform.md`; `TODOS.md`.
- Machine-local (original workstation only, optional): approved plan `~/.claude/plans/analyse-the-current-repo-swirling-quill.md`; CEO review doc `~/.gstack/projects/vrknetha-myclaw/ceo-plans/2026-06-11-deployment-profiles.md`. Everything needed to continue is in-repo.
