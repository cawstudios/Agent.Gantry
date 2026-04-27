# Session Resume

MyClaw has two resume paths.

## Provider-Native Resume

Provider-native resume uses `ProviderSession` metadata plus the latest matching
`ProviderSessionArtifact`.

For Claude:

1. Resolve canonical `AgentSession`.
2. Resolve active `ProviderSession`.
3. Load latest `claude-jsonl` artifact through `ProviderArtifactStore`.
4. Verify artifact hash and size.
5. Materialize the artifact into a temporary Claude config directory.
6. Run Claude with `resume`.
7. Capture updated JSONL/session index artifacts and remove the temporary
   directory.

The JSONL artifact is provider continuation state only.

## DB Replay Fallback

When provider-native resume is unavailable, MyClaw hydrates context from
canonical Postgres data: summaries, recent messages, recent runs, and memory.
The replay context is untrusted evidence for continuity and does not grant
instruction authority or tool permission.

Missing artifacts use DB replay. Corrupt artifacts expire provider-native
resume metadata and then use DB replay. Artifact store infrastructure failures
fail loudly because silently losing continuation state would hide data-loss
conditions.
