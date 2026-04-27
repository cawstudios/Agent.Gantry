# Provider Session Artifacts

Provider session artifacts are provider-owned continuation files attached to a
canonical `AgentSession` and `ProviderSession`. They are not canonical
conversation history.

Canonical MyClaw state remains in Postgres:

- conversations, threads, messages, and message parts
- agent sessions and provider session metadata
- agent runs and run events
- summaries, memory, jobs, permissions, and control events

Provider artifacts hold provider-specific bytes that may help a provider resume
native state. For the Claude adapter this includes JSONL transcripts and
session indexes.

## Artifact Store Contract

Runtime code reads and writes provider artifacts only through
`ProviderArtifactStore`.

Supported artifact kinds:

- `claude-jsonl`
- `claude-session-index`
- `provider-state`
- `transcript-export`

Supported storage types:

- `local-filesystem`: production-supported for single-node or shared-volume
  deployments
- `postgres`: small/bootstrap/test storage where content is stored in Postgres
- `object-store`: future S3/R2/GCS/MinIO-style storage

Every artifact records ownership, storage location, hash, size, creation time,
and metadata in Postgres. The active provider session points at its latest
artifact id.

## Claude Resume Flow

Before Claude native resume, the Claude runtime materializer loads the latest
`claude-jsonl` artifact for the active provider session, verifies hash and size,
and materializes it into a temporary `CLAUDE_CONFIG_DIR`.

After the run, MyClaw captures updated Claude JSONL and session index files from
that temporary directory, stores them through `ProviderArtifactStore`, updates
the provider session latest artifact pointer, and removes the temporary
directory.

The same temp directory also contains generated `settings.json` and
materialized `skills/`. Those files are generated compatibility inputs for
Claude and are not provider artifacts.

If no artifact exists, MyClaw uses DB replay hydration from canonical messages,
summaries, runs, and memory. If the artifact is corrupt, native provider resume
metadata is expired and DB replay is used. If the artifact store itself is not
available, the run fails loudly.

## Local Filesystem Backend

The local filesystem backend stores artifact bytes under:

```text
<runtime-home>/artifacts/provider-sessions/
```

The adapter owns the exact layout, validates paths stay inside the artifact
root, and writes files atomically. Runtime and provider code must never build
durable Claude JSONL paths directly.

This backend is appropriate for one production node or a shared mounted volume.
Horizontal scaling requires either a shared filesystem with the same artifact
root mounted everywhere or an `object-store` adapter.

## Transcript Export

Markdown transcript exports are explicit artifacts with kind
`transcript-export`. They are generated from stored provider artifacts and are
not hidden durable runtime state under `data/session-archives`.
