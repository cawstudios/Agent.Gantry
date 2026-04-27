# Claude Runtime Materialization

## Status

Accepted.

## Context

Claude needs a filesystem config directory for settings, skills, and native
session files. Previous runtime setup generated shared durable files under
the runtime-home Claude directory, which made Claude-local files an implicit
runtime source of truth.

Enterprise MyClaw must instead use canonical app, agent, config, skill,
permission, memory, session, and message state from Postgres, plus provider
artifacts behind `ProviderArtifactStore`.

## Decision

The Anthropic Claude adapter owns runtime materialization. For every Claude run
it creates a temporary `CLAUDE_CONFIG_DIR`, renders `settings.json`,
materializes enabled skills, restores provider artifacts, runs Claude, captures
updated artifacts, and removes the temp directory.

Runtime startup no longer creates runtime-home Claude settings or syncs
runtime-home Claude skills.

## Consequences

- Claude runtime files are scratch files, not durable MyClaw state.
- `settings.local.json` is not read in enterprise runtime.
- Host permission policy remains authoritative.
- Existing old local `.claude` files are not imported automatically.
- The bundled-skill source is temporary until the DB/artifact-backed skill
  registry is available.
