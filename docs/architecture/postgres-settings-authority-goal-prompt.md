# Goal Prompt: Postgres Settings Authority

Pursue this as a `/goal` implementation task in Gantry.

## Objective

Make Postgres `settings_revisions` the durable desired-state source of truth for managed workstation/personal mode and fleet mode. Keep `settings.yaml` as the canonical human-readable synced copy, bootstrap/import/export surface, and offline edit surface.

## Contract

- Startup with an existing latest revision loads that revision as durable authority.
- If `settings.yaml` changed while Gantry was stopped, startup imports the valid file as the next revision before syncing runtime projection.
- If `settings.yaml` is invalid while a valid latest revision exists, startup logs/rejects the file edit and continues from the latest revision.
- Every managed settings mutation path appends a revision, updates runtime projection, and syncs `settings.yaml` before reporting success.
- Revision append success plus local apply failure must not be reported as a successful mutation.
- `settings.yaml` watcher remains an import path into Postgres, not an independent durable authority.
- Existing local/fleet rows and compact YAML shapes must keep parsing through the migration.

## Required Surfaces

- Startup revision/file arbitration.
- Settings import/export and desired-state writer.
- Control API desired-state settings routes.
- CLI settings import/export.
- Approved Gantry admin settings update path.
- Runtime watcher sync.
- Docs and AGENTS.md authority wording.
- Focused unit/integration coverage for stale revision, offline edit import, invalid file fallback, and legacy credential/ref shapes.

## Required Closeout

- Use the `ponytail` skill to keep the implementation minimal.
- Run focused tests, `python3 .codex/scripts/verify.py`, artifact validation, cleanup searches, and `autoreview`.
- Fix accepted autoreview findings.
- Commit and update the same PR with implementation and verification evidence.
