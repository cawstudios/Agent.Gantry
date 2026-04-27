# 2026-04-27 — Provider Session Artifact Store

## Context

Claude JSONL/session files were being treated as durable local runtime state.
That couples MyClaw session continuity to one provider, one filesystem layout,
and one machine.

Canonical conversations and messages already live in Postgres. Provider files
should be provider continuation artifacts, not canonical history.

## Decision

MyClaw stores provider continuation files through `ProviderArtifactStore`.

- `local-filesystem` is supported for single-node production and shared-volume
  deployments.
- `postgres` is supported for small/bootstrap/test artifacts.
- `object-store` is the scale extension point for S3, R2, GCS, or MinIO.
- Artifact metadata, hash, size, ownership, deletion state, and latest pointers
  live in Postgres.
- Claude JSONL is restored only into a temporary run directory before native
  resume.
- Markdown transcript export is an explicit `transcript-export` artifact.

No automatic import is provided for old local Claude JSONL files.

## Consequences

Runtime and provider code must not construct durable Claude JSONL paths
directly. They must use `ProviderArtifactStore`.

Single-node deployments can use local filesystem artifact bytes. Multi-node
deployments need a shared filesystem or object-store adapter.

DB replay remains the fallback when provider artifacts are missing or expired.
